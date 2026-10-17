//! Bounded access to model outputs and audio imported by the desktop application.
//!
//! Every path returned to the UI is canonical and contained in this lab. Run IDs
//! and artifact names are identifiers, never arbitrary filesystem paths.

use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_AUDIO_BYTES: u64 = 250 * 1024 * 1024;
const MAX_SUMMARY_BYTES: u64 = 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const MAX_ABC_BYTES: u64 = 4 * 1024 * 1024;
const MAX_EVENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CATALOG_ENTRIES: usize = 10_000;

#[derive(Serialize, Clone, Debug)]
pub struct AudioAsset {
    pub path: String,
    pub name: String,
    pub url: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RunRecord {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub duration_seconds: f64,
    pub elapsed_seconds: f64,
}

fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "The selected path is not valid Unicode".to_owned())
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("Cannot open lab: {e}"))?;
    if !root.is_dir() {
        return Err("The lab root must be a directory".to_owned());
    }
    Ok(root)
}

fn contained_path(base: &Path, path: &Path) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("Cannot open file: {e}"))?;
    if !path.starts_with(base) {
        return Err("The requested path is outside the allowed directory".to_owned());
    }
    Ok(path)
}

fn outputs_directory(root: &Path) -> Result<PathBuf, String> {
    let root = canonical_root(root)?;
    let outputs = contained_path(&root, &root.join("runtime/outputs"))?;
    if !outputs.is_dir() {
        return Err("The outputs path must be a directory".to_owned());
    }
    Ok(outputs)
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid run ID".to_owned());
    }
    Ok(())
}

/// Resolve an existing run without allowing traversal or symlink escapes.
pub fn run_directory(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    let outputs = outputs_directory(root)?;
    let run = contained_path(&outputs, &outputs.join(id))?;
    if run == outputs || !run.is_dir() {
        return Err("The requested run is not a directory".to_owned());
    }
    Ok(run)
}

fn read_text(base: &Path, path: &Path, limit: u64) -> Result<String, String> {
    let path = contained_path(base, path)?;
    if !path.is_file() {
        return Err("The requested artifact is not a regular file".to_owned());
    }
    let file = File::open(&path).map_err(|e| format!("Cannot read artifact: {e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err("The requested artifact exceeds the size limit".to_owned());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Cannot read artifact: {e}"))?;
    if bytes.len() as u64 > limit {
        return Err("The requested artifact exceeds the size limit".to_owned());
    }
    String::from_utf8(bytes).map_err(|_| "The artifact is not valid UTF-8".to_owned())
}

fn read_json(base: &Path, path: &Path, limit: u64) -> Result<Value, String> {
    serde_json::from_str(&read_text(base, path, limit)?)
        .map_err(|e| format!("Invalid artifact JSON: {e}"))
}

fn summary(run: &Path) -> Result<Value, String> {
    // The model writes result.json before the worker publishes its final result.
    // A desktop job is complete only after ui.json is atomically published; this
    // excludes cancellation after inference while preserving older CLI runs.
    let desktop_job = run
        .join(".desktop-job.json")
        .try_exists()
        .map_err(|e| e.to_string())?;
    let published = run
        .join("ui.json")
        .try_exists()
        .map_err(|e| e.to_string())?;
    if desktop_job && !published {
        return Err("This desktop transcription has not completed".to_owned());
    }
    let value = read_json(run, &run.join("result.json"), MAX_SUMMARY_BYTES)?;
    if !value.is_object() {
        return Err("Run summary must be a JSON object".to_owned());
    }
    for field in ["duration_seconds", "elapsed_seconds"] {
        let number = value
            .get(field)
            .and_then(Value::as_f64)
            .ok_or_else(|| format!("Run summary is missing {field}"))?;
        if !number.is_finite() || number < 0.0 {
            return Err(format!("Run summary has invalid {field}"));
        }
    }
    let audio = value
        .get("audio")
        .and_then(Value::as_str)
        .ok_or_else(|| "Run summary is missing audio".to_owned())?;
    if audio.is_empty() || audio.len() > 1024 {
        return Err("Run summary has invalid audio name".to_owned());
    }
    Ok(value)
}

fn metadata(run: &Path) -> Result<Value, String> {
    let path = run.join("ui.json");
    if !path.try_exists().map_err(|e| e.to_string())? {
        return Ok(json!({}));
    }
    let value = read_json(run, &path, MAX_METADATA_BYTES)?;
    if !value.is_object() {
        return Err("Run metadata must be a JSON object".to_owned());
    }
    Ok(value)
}

fn display_name(meta: &Value, summary: &Value) -> String {
    meta.get("audio_name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty() && name.len() <= 1024)
        .unwrap_or_else(|| summary["audio"].as_str().unwrap_or("Audio"))
        .to_owned()
}

fn timestamp_from_id(id: &str) -> String {
    // Both legacy <name>-<timestamp> and desktop <name>-<timestamp>-<nonce>
    // IDs contain YYYYMMDDTHHMMSSffffffZ as one hyphen-separated component.
    let stamp = id.rsplit('-').find(|part| {
        part.len() >= 16
            && part.is_ascii()
            && part.as_bytes()[8] == b'T'
            && part.ends_with('Z')
            && part[..8].bytes().all(|c| c.is_ascii_digit())
            && part[9..part.len() - 1].bytes().all(|c| c.is_ascii_digit())
    });
    if let Some(stamp) = stamp {
        let fractional = &stamp[15..stamp.len() - 1];
        let fraction = if fractional.is_empty() {
            String::new()
        } else {
            format!(".{fractional}")
        };
        return format!(
            "{}-{}-{}T{}:{}:{}{}Z",
            &stamp[..4],
            &stamp[4..6],
            &stamp[6..8],
            &stamp[9..11],
            &stamp[11..13],
            &stamp[13..15],
            fraction
        );
    }
    id.to_owned()
}

/// List completed, parseable runs. Incomplete or malformed run directories are skipped.
pub fn list_runs(root: &Path) -> Result<Vec<RunRecord>, String> {
    let canonical = canonical_root(root)?;
    if !canonical
        .join("runtime/outputs")
        .try_exists()
        .map_err(|e| e.to_string())?
    {
        return Ok(Vec::new());
    }
    let outputs = outputs_directory(&canonical)?;
    let entries = fs::read_dir(&outputs).map_err(|e| format!("Cannot list runs: {e}"))?;
    let mut records = Vec::new();
    for entry in entries.take(MAX_CATALOG_ENTRIES) {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };
        let id = match entry.file_name().to_str() {
            Some(value) => value.to_owned(),
            None => continue,
        };
        let run = match run_directory(&canonical, &id) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let result = match summary(&run) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let meta = match metadata(&run) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let created_at = meta
            .get("created_at")
            .and_then(Value::as_str)
            .filter(|value| value.len() <= 128 && !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| timestamp_from_id(&id));
        records.push(RunRecord {
            name: display_name(&meta, &result),
            id,
            created_at,
            duration_seconds: result["duration_seconds"].as_f64().unwrap_or(0.0),
            elapsed_seconds: result["elapsed_seconds"].as_f64().unwrap_or(0.0),
        });
    }
    records.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(records)
}

/// Load the score, playback notes, events, and source audio for one completed run.
pub fn load_run(root: &Path, id: &str) -> Result<Value, String> {
    let root = canonical_root(root)?;
    let run = run_directory(&root, id)?;
    let result = summary(&run)?;
    let meta = metadata(&run)?;
    let audio_path = if let Some(path) = meta.get("audio_path").and_then(Value::as_str) {
        let path = Path::new(path);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        };
        contained_path(&root, &path)?
    } else {
        let audio = result["audio"].as_str().unwrap_or("");
        if Path::new(audio).components().count() != 1 || audio == "." || audio == ".." {
            return Err("Legacy run audio must be a simple filename".to_owned());
        }
        contained_path(&root, &root.join("samples").join(audio))?
    };
    if !audio_path.is_file() {
        return Err("Run audio is not a regular file".to_owned());
    }
    let browser_score = run.join("score.browser.abc");
    let score = run.join("score.abc");
    let abc = if browser_score.exists() {
        read_text(&run, &browser_score, MAX_ABC_BYTES)?
    } else if score.exists() {
        read_text(&run, &score, MAX_ABC_BYTES)?
    } else {
        String::new()
    };
    let playback = read_json(&run, &run.join("playback.json"), MAX_EVENT_BYTES)?;
    let events = read_json(&run, &run.join("events.json"), MAX_EVENT_BYTES)?;
    Ok(json!({
        "run_id": id,
        "output_dir": path_string(&run)?,
        "audio_path": path_string(&audio_path)?,
        "audio_name": display_name(&meta, &result),
        "summary": result,
        "abc": abc,
        "playback": playback,
        "events": events,
    }))
}

fn audio_asset(root: &Path, path: &Path, name: String) -> Result<AudioAsset, String> {
    let path = contained_path(root, path)?;
    if !path.is_file() {
        return Err("The audio path must be a regular file".to_owned());
    }
    Ok(AudioAsset {
        path: path_string(&path)?,
        name,
        url: None,
    })
}

pub fn sample_asset(root: &Path) -> Result<AudioAsset, String> {
    let root = canonical_root(root)?;
    audio_asset(&root, &root.join("samples/demo.mp3"), "demo.mp3".to_owned())
}

/// Copy a native file selection into the lab; never rename or overwrite its source.
pub fn import_audio(root: &Path, source: &Path) -> Result<AudioAsset, String> {
    let root = canonical_root(root)?;
    let source = source
        .canonicalize()
        .map_err(|e| format!("Cannot open selected audio: {e}"))?;
    if !source.is_file() {
        return Err("Select a regular audio file".to_owned());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ![
        "mp3", "wav", "flac", "ogg", "m4a", "aac", "aiff", "aif", "opus",
    ]
    .contains(&extension.as_str())
    {
        return Err("Unsupported audio format".to_owned());
    }
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "The audio filename is not valid Unicode".to_owned())?
        .to_owned();
    let source_file =
        File::open(&source).map_err(|e| format!("Cannot read selected audio: {e}"))?;
    if source_file.metadata().map_err(|e| e.to_string())?.len() > MAX_AUDIO_BYTES {
        return Err("Audio files must be no larger than 250 MiB".to_owned());
    }
    // Validate parents before creating the uploads directory, including symlinks.
    let runtime = contained_path(&root, &root.join("runtime"))?;
    fs::create_dir_all(runtime.join("uploads"))
        .map_err(|e| format!("Cannot create upload directory: {e}"))?;
    let uploads = contained_path(&root, &runtime.join("uploads"))?;
    let safe_name: String = name
        .chars()
        .take(180)
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let target = uploads.join(format!("{nonce}-{safe_name}"));
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("Cannot import audio: {e}"))?;
    let copy_result = std::io::copy(&mut source_file.take(MAX_AUDIO_BYTES + 1), &mut destination)
        .map_err(|e| format!("Cannot copy audio: {e}"));
    let copied = match copy_result {
        Ok(size) if size <= MAX_AUDIO_BYTES => size,
        result => {
            drop(destination);
            let _ = fs::remove_file(&target);
            return Err(result
                .err()
                .unwrap_or_else(|| "Audio files must be no larger than 250 MiB".to_owned()));
        }
    };
    if copied == 0 {
        drop(destination);
        let _ = fs::remove_file(&target);
        return Err("The selected audio file is empty".to_owned());
    }
    destination
        .flush()
        .map_err(|e| format!("Cannot save imported audio: {e}"))?;
    audio_asset(&root, &target, name)
}

/// The UI can export only these known artifacts from an existing run.
pub fn artifact_path(root: &Path, id: &str, artifact: &str) -> Result<PathBuf, String> {
    let filename = match artifact {
        "abc" => "score.abc",
        "midi" => "transcription.mid",
        "events" => "events.json",
        _ => return Err("Unknown artifact; choose abc, midi, or events".to_owned()),
    };
    let run = run_directory(root, id)?;
    let path = contained_path(&run, &run.join(filename))?;
    if !path.is_file() {
        return Err("The artifact is not a regular file".to_owned());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir()
                .join(format!("sheetsage-catalog-{}-{nonce}", std::process::id()));
            fs::create_dir_all(root.join("runtime/outputs")).unwrap();
            fs::create_dir_all(root.join("samples")).unwrap();
            fs::write(root.join("samples/demo.mp3"), b"test audio").unwrap();
            Self {
                root: root.canonicalize().unwrap(),
            }
        }
        fn run(&self, id: &str) -> PathBuf {
            let run = self.root.join("runtime/outputs").join(id);
            fs::create_dir_all(&run).unwrap();
            fs::write(
                run.join("result.json"),
                r#"{"audio":"demo.mp3","duration_seconds":20.0,"elapsed_seconds":21.2}"#,
            )
            .unwrap();
            fs::write(run.join("score.abc"), "X:1\nK:C\nCDEF|").unwrap();
            fs::write(run.join("playback.json"), r#"{"tracks":[]}"#).unwrap();
            fs::write(run.join("events.json"), "[]").unwrap();
            fs::write(run.join("transcription.mid"), b"MThd").unwrap();
            run
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn rejects_traversal_and_unknown_artifacts() {
        let fixture = Fixture::new();
        fixture.run("demo-20261017T223132317210Z");
        for id in ["", "..", "../samples", "/tmp", "a/b", "a\\b", "a.b"] {
            assert!(run_directory(&fixture.root, id).is_err(), "accepted {id}");
        }
        assert!(artifact_path(
            &fixture.root,
            "demo-20261017T223132317210Z",
            "../result.json"
        )
        .is_err());
        assert!(
            artifact_path(&fixture.root, "demo-20261017T223132317210Z", "abc")
                .unwrap()
                .ends_with("score.abc")
        );
    }

    #[test]
    fn catalog_skips_partial_runs_and_orders_timestamps() {
        let fixture = Fixture::new();
        fixture.run("demo-20261017T223132317210Z");
        fixture.run("audio-20261018T010000000001Z-abcdef12");
        let invalid = fixture.run("unfinished");
        fs::write(invalid.join("result.json"), "{\"error\":\"failed\"}").unwrap();
        let records = list_runs(&fixture.root).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].id, "audio-20261018T010000000001Z-abcdef12");
        assert_eq!(records[1].created_at, "2026-10-17T22:31:32.317210Z");
        assert_eq!(records[0].duration_seconds, 20.0);
    }

    #[test]
    fn unpublished_desktop_results_are_not_history() {
        let fixture = Fixture::new();
        let run = fixture.run("cancelled-20261018T010000000001Z-abcdef12");
        fs::write(run.join(".desktop-job.json"), "{}").unwrap();
        assert!(list_runs(&fixture.root).unwrap().is_empty());
        assert!(load_run(&fixture.root, "cancelled-20261018T010000000001Z-abcdef12").is_err());

        fs::write(run.join("ui.json"), "{}").unwrap();
        assert_eq!(list_runs(&fixture.root).unwrap().len(), 1);
        assert!(load_run(&fixture.root, "cancelled-20261018T010000000001Z-abcdef12").is_ok());
    }

    #[test]
    fn loads_legacy_run_and_imported_audio_metadata() {
        let fixture = Fixture::new();
        let run = fixture.run("demo-20261017T223132317210Z");
        let data = load_run(&fixture.root, "demo-20261017T223132317210Z").unwrap();
        assert_eq!(data["audio_name"], "demo.mp3");
        assert!(data["abc"].as_str().unwrap().contains("K:C"));
        let imported = import_audio(&fixture.root, &fixture.root.join("samples/demo.mp3")).unwrap();
        assert!(Path::new(&imported.path).starts_with(fixture.root.join("runtime/uploads")));
        assert_eq!(imported.name, "demo.mp3");
        assert!(imported.url.is_none());
        fs::write(
            run.join("ui.json"),
            json!({"audio_path": imported.path, "audio_name": "My song.mp3"}).to_string(),
        )
        .unwrap();
        let data = load_run(&fixture.root, "demo-20261017T223132317210Z").unwrap();
        assert_eq!(data["audio_name"], "My song.mp3");
        assert!(fixture.root.join("samples/demo.mp3").exists());
    }

    #[test]
    fn a_valid_run_without_abc_still_loads_for_piano_roll_and_events() {
        let fixture = Fixture::new();
        let run = fixture.run("no-score");
        fs::remove_file(run.join("score.abc")).unwrap();
        let data = load_run(&fixture.root, "no-score").unwrap();
        assert_eq!(data["abc"], "");
        assert!(data["playback"].is_object());
    }

    #[test]
    fn rejects_oversized_or_unsupported_imports() {
        let fixture = Fixture::new();
        let bad = fixture.root.join("no.txt");
        fs::write(&bad, "not audio").unwrap();
        assert!(import_audio(&fixture.root, &bad).is_err());
        let large = fixture.root.join("large.wav");
        File::create(&large)
            .unwrap()
            .set_len(MAX_AUDIO_BYTES + 1)
            .unwrap();
        assert!(import_audio(&fixture.root, &large).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escapes() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        let run = fixture.run("safe");
        symlink(&outside.root, fixture.root.join("runtime/outputs/escape")).unwrap();
        assert!(run_directory(&fixture.root, "escape").is_err());
        fs::remove_file(run.join("score.abc")).unwrap();
        symlink(outside.root.join("samples/demo.mp3"), run.join("score.abc")).unwrap();
        assert!(artifact_path(&fixture.root, "safe", "abc").is_err());
        fs::write(
            run.join("ui.json"),
            json!({"audio_path": outside.root.join("samples/demo.mp3")}).to_string(),
        )
        .unwrap();
        assert!(load_run(&fixture.root, "safe").is_err());
    }
}
