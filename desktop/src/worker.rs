//! A single, persistent Python process with a JSON-lines protocol.
//!
//! The model runs outside the GUI process. Rust forwards genuine worker events
//! to the webview; no estimated progress percentage is fabricated.

use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct WorkerStatus {
    pub model_loaded: bool,
    pub busy: bool,
    pub state: String,
    pub message: String,
    pub job_id: Option<String>,
}

impl Default for WorkerStatus {
    fn default() -> Self {
        Self {
            model_loaded: false,
            busy: false,
            state: "idle".into(),
            message: "Model will load when you start a transcription.".into(),
            job_id: None,
        }
    }
}

struct WorkerProcess {
    child: Child,
    input: ChildStdin,
}

pub struct DesktopState {
    pub lab_root: PathBuf,
    worker: Mutex<Option<WorkerProcess>>,
    pub status: Arc<Mutex<WorkerStatus>>,
    generation: Arc<AtomicU64>,
}

impl DesktopState {
    pub fn new(lab_root: PathBuf) -> Self {
        Self {
            lab_root,
            worker: Mutex::new(None),
            status: Arc::new(Mutex::new(WorkerStatus::default())),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn status(&self) -> Result<WorkerStatus, String> {
        self.status
            .lock()
            .map(|s| s.clone())
            .map_err(|e| e.to_string())
    }

    pub fn submit(&self, app: &AppHandle, mut request: Value) -> Result<String, String> {
        let mut worker = self.worker.lock().map_err(|e| e.to_string())?;
        if let Some(process) = worker.as_mut() {
            if process
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                *worker = None;
            }
        }
        if self.status()?.busy {
            return Err("A model operation is already running.".into());
        }
        if worker.is_none() {
            *worker = Some(self.spawn(app)?);
        }

        let id = format!("job-{}", now_nanos());
        request["id"] = json!(id);
        let loading = request["command"] == "load" || !self.status()?.model_loaded;
        let state = if loading { "loading" } else { "transcribing" };
        let message = if loading {
            "Loading SheetSage2 from local checkpoints…"
        } else {
            "Preparing your recording…"
        };
        {
            let mut status = self.status.lock().map_err(|e| e.to_string())?;
            status.busy = true;
            status.state = state.into();
            status.message = message.into();
            status.job_id = Some(id.clone());
        }
        let _ = app.emit(
            "model-event",
            json!({
                "id": id, "type": "status", "state": state, "message": message,
                "model_loaded": self.status()?.model_loaded
            }),
        );
        let process = worker.as_mut().ok_or("Model worker is unavailable.")?;
        if let Err(error) =
            writeln!(process.input, "{}", request).and_then(|_| process.input.flush())
        {
            let mut status = self.status.lock().map_err(|e| e.to_string())?;
            status.busy = false;
            status.model_loaded = false;
            return Err(format!("Cannot send a request to the model: {error}"));
        }
        Ok(id)
    }

    fn spawn(&self, app: &AppHandle) -> Result<WorkerProcess, String> {
        let runtime = self.lab_root.join("runtime");
        let python = runtime.join(".venv/bin/python");
        if !python.is_file() {
            return Err("Python runtime is missing. Run the lab's setup command first.".into());
        }
        let separator = if cfg!(windows) { ";" } else { ":" };
        let path = format!(
            "{}{}{}",
            runtime.join(".venv/bin").display(),
            separator,
            std::env::var("PATH").unwrap_or_default()
        );
        let mut child = Command::new(python)
            .arg("-u")
            .arg(self.lab_root.join("desktop/worker.py"))
            .arg("--lab-root")
            .arg(&self.lab_root)
            .current_dir(&self.lab_root)
            .env("HF_HOME", runtime.join("huggingface"))
            .env("HF_HUB_CACHE", runtime.join("huggingface/hub"))
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
            .env("TOKENIZERS_PARALLELISM", "false")
            .env("PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Cannot start the model worker: {e}"))?;
        let input = child.stdin.take().ok_or("Worker stdin was unavailable.")?;
        let output = child
            .stdout
            .take()
            .ok_or("Worker stdout was unavailable.")?;
        let errors = child
            .stderr
            .take()
            .ok_or("Worker stderr was unavailable.")?;

        let my_generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let generation = self.generation.clone();
        self.status.lock().map_err(|e| e.to_string())?.model_loaded = false;

        let handle = app.clone();
        let status = self.status.clone();
        thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if generation.load(Ordering::SeqCst) != my_generation {
                    return;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(event) => {
                        if let Ok(mut snapshot) = status.lock() {
                            if !event_matches_job(&snapshot, &event) {
                                continue;
                            }
                            update_status(&mut snapshot, &event);
                        }
                        let _ = handle.emit("model-event", event);
                    }
                    Err(_) => {
                        eprintln!("model worker (non-protocol output): {line}");
                    }
                }
            }
            if generation.load(Ordering::SeqCst) != my_generation {
                return;
            }
            if let Ok(mut snapshot) = status.lock() {
                snapshot.busy = false;
                snapshot.model_loaded = false;
                snapshot.state = "idle".into();
                snapshot.message =
                    "Model worker stopped. Start a transcription to reconnect.".into();
            }
            let _ = handle.emit(
                "model-event",
                json!({
                    "type": "status", "state": "idle", "model_loaded": false,
                    "message": "Model worker stopped. Start a transcription to reconnect."
                }),
            );
        });
        thread::spawn(move || {
            for line in BufReader::new(errors).lines().map_while(Result::ok) {
                eprintln!("model: {line}");
            }
        });
        Ok(WorkerProcess { child, input })
    }

    pub fn cancel(&self) -> Result<(), String> {
        let mut worker = self.worker.lock().map_err(|e| e.to_string())?;
        let snapshot = self.status()?;
        if !snapshot.busy {
            return Ok(());
        }
        if let Some(process) = worker.as_mut() {
            writeln!(
                process.input,
                "{}",
                json!({"id": snapshot.job_id, "command": "cancel"})
            )
            .and_then(|_| process.input.flush())
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(mut process) = worker.take() {
                let _ = process.child.kill();
                let _ = process.child.wait();
            }
        }
    }
}

fn event_matches_job(status: &WorkerStatus, event: &Value) -> bool {
    if event["type"] == "connected" {
        return false;
    }
    match (status.job_id.as_deref(), event["id"].as_str()) {
        (Some(active), Some(incoming)) => active == incoming,
        _ => true,
    }
}

fn update_status(status: &mut WorkerStatus, event: &Value) {
    if let Some(loaded) = event["model_loaded"].as_bool() {
        status.model_loaded = loaded;
    }
    match event["type"].as_str().unwrap_or_default() {
        "status" => {
            if let Some(state) = event["state"].as_str() {
                status.state = state.into();
                status.busy = matches!(state, "loading" | "transcribing" | "cancelling");
            }
            if let Some(message) = event["message"].as_str() {
                status.message = message.into();
            }
        }
        "result" | "error" | "cancelled" => status.busy = false,
        _ => {}
    }
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actual_worker_events_drive_busy_and_loaded_states() {
        let mut status = WorkerStatus::default();
        update_status(
            &mut status,
            &json!({"type":"status","state":"loading","model_loaded":false}),
        );
        assert!(status.busy);
        assert!(!status.model_loaded);
        update_status(
            &mut status,
            &json!({"type":"status","state":"ready","model_loaded":true}),
        );
        assert!(!status.busy);
        assert!(status.model_loaded);
        update_status(
            &mut status,
            &json!({"type":"status","state":"transcribing"}),
        );
        update_status(&mut status, &json!({"type":"error","message":"bad audio"}));
        assert!(!status.busy);
        assert!(status.model_loaded);
    }

    #[test]
    fn startup_and_previous_job_events_cannot_finish_a_new_job() {
        let status = WorkerStatus {
            busy: true,
            job_id: Some("job-new".into()),
            ..Default::default()
        };
        assert!(!event_matches_job(
            &status,
            &json!({"type":"connected","id":null})
        ));
        assert!(!event_matches_job(
            &status,
            &json!({"type":"status","state":"ready","id":"job-old"})
        ));
        assert!(event_matches_job(
            &status,
            &json!({"type":"progress","id":"job-new"})
        ));
    }
}
