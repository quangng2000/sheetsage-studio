#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod catalog;
mod worker;

use catalog::AudioAsset;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use worker::DesktopState;

fn lab_root() -> PathBuf {
    std::env::var_os("SHEETSAGE_LAB_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .to_path_buf()
        })
}

#[tauri::command]
fn get_initial_state(state: State<'_, DesktopState>) -> Result<Value, String> {
    let root = &state.lab_root;
    let runs = catalog::list_runs(root)?;
    let latest = runs
        .iter()
        .find_map(|run| catalog::load_run(root, &run.id).ok());
    let status = state.status()?;
    Ok(json!({
        "lab_root": root.to_string_lossy(),
        "model_installed": root.join("runtime/model/model.safetensors").is_file(),
        "python_available": root.join("runtime/.venv/bin/python").is_file(),
        "model_loaded": status.model_loaded, "busy": status.busy,
        "status": status,
        "sample": catalog::sample_asset(root).ok(),
        "runs": runs, "latest_result": latest
    }))
}

#[tauri::command]
async fn pick_audio(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Option<AudioAsset>, String> {
    let root = state.lab_root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("Choose a music recording")
            .add_filter(
                "Audio",
                &[
                    "mp3", "wav", "flac", "ogg", "m4a", "aac", "aiff", "aif", "opus",
                ],
            )
            .blocking_pick_file();
        let Some(file) = selected else {
            return Ok(None);
        };
        let source = file.into_path().map_err(|e| e.to_string())?;
        catalog::import_audio(&root, &source).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn select_sample(state: State<'_, DesktopState>) -> Result<AudioAsset, String> {
    catalog::sample_asset(&state.lab_root)
}

#[tauri::command]
fn get_run(run_id: String, state: State<'_, DesktopState>) -> Result<Value, String> {
    catalog::load_run(&state.lab_root, &run_id)
}

#[tauri::command]
fn warm_model(app: AppHandle, state: State<'_, DesktopState>) -> Result<Value, String> {
    let id = state.submit(&app, json!({"command": "load"}))?;
    Ok(json!({"id": id}))
}

#[tauri::command]
fn start_transcription(
    audio_path: String,
    max_seconds: f64,
    audio_name: Option<String>,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Value, String> {
    if !max_seconds.is_finite() || max_seconds <= 0.0 || max_seconds > 300.0 {
        return Err("Choose an excerpt between 1 and 300 seconds.".into());
    }
    let path = Path::new(&audio_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let root = state.lab_root.canonicalize().map_err(|e| e.to_string())?;
    if !(path.starts_with(root.join("samples")) || path.starts_with(root.join("runtime/uploads")))
        || !path.is_file()
    {
        return Err("Choose audio with the app's file picker or sample button.".into());
    }
    let stored_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio");
    let fallback_name = if path.starts_with(root.join("runtime/uploads")) {
        stored_name
            .split_once('-')
            .map(|(_, name)| name)
            .unwrap_or(stored_name)
    } else {
        stored_name
    };
    let audio_name = audio_name
        .as_deref()
        .filter(|name| {
            !name.is_empty()
                && name.len() <= 1024
                && !name.contains('/')
                && !name.contains('\\')
                && !name.contains('\0')
        })
        .unwrap_or(fallback_name);
    let id = state.submit(
        &app,
        json!({
            "command": "transcribe", "audio_path": path.to_string_lossy(),
            "audio_name": audio_name, "max_seconds": max_seconds
        }),
    )?;
    Ok(json!({"id": id}))
}

#[tauri::command]
fn cancel_job(state: State<'_, DesktopState>) -> Result<(), String> {
    state.cancel()
}

#[tauri::command]
async fn export_artifact(
    run_id: String,
    artifact: String,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Option<String>, String> {
    let source = catalog::artifact_path(&state.lab_root, &run_id, &artifact)?;
    // The catalog has already validated the identifier against its allowlist.
    // Preserve each annotation's filename so beat/key/LAB exports do not collide.
    let basename = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("The selected artifact has no valid filename.")?;
    let filename = format!("{run_id}-{basename}");
    tauri::async_runtime::spawn_blocking(move || {
        // Do not infer a native file type from these suffixes: musical ABC can
        // resolve to Alembic on macOS, while LAB is an undeclared dynamic type.
        // The catalog already restricts the source; keep its suggested suffix
        // without restricting the user's destination through native filters.
        let destination = app
            .dialog()
            .file()
            .set_title("Export musical analysis")
            .set_file_name(&filename)
            .blocking_save_file();
        let Some(file) = destination else {
            return Ok(None);
        };
        let target = file.into_path().map_err(|e| e.to_string())?;
        if target.canonicalize().ok().as_ref() != Some(&source) {
            std::fs::copy(&source, &target).map_err(|e| e.to_string())?;
        }
        Ok(Some(target.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_output(run_id: String, state: State<'_, DesktopState>) -> Result<(), String> {
    let directory = catalog::run_directory(&state.lab_root, &run_id)?;
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(not(target_os = "macos"))]
    let mut command = std::process::Command::new("xdg-open");
    command.arg(directory).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    let root = lab_root()
        .canonicalize()
        .expect("Cannot locate the SheetSage2 lab");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::new(root.clone()))
        .setup(move |app| {
            std::fs::create_dir_all(root.join("runtime/uploads"))?;
            app.asset_protocol_scope()
                .allow_directory(root.join("samples"), true)?;
            app.asset_protocol_scope()
                .allow_directory(root.join("runtime/uploads"), true)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_state,
            pick_audio,
            select_sample,
            get_run,
            warm_model,
            start_transcription,
            cancel_job,
            export_artifact,
            open_output
        ])
        .build(tauri::generate_context!())
        .expect("Cannot start SheetSage Studio");
    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            handle.state::<DesktopState>().shutdown();
        }
    });
}
