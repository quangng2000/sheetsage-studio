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

// Keep this registry aligned with desktop/worker.py. Callers provide IDs only;
// neither annotation loading nor export accepts an arbitrary file path.
const ARTIFACTS: &[(&str, &str, &str, &str)] = &[
    ("abc", "score.abc", "ABC score", "notation"),
    ("midi", "transcription.mid", "Arrangement MIDI", "midi"),
    ("events", "events.json", "Raw model events", "json"),
    ("summary", "result.json", "Analysis summary", "json"),
    ("playback", "playback.json", "Playback tracks", "json"),
    ("events_tsv", "events.tsv", "Event table", "table"),
    ("beat", "beat.lab", "Beat grid", "annotation"),
    ("downbeat", "downbeat.lab", "Downbeats", "annotation"),
    (
        "rhythm_events",
        "rhythm_events.lab",
        "Raw rhythm events",
        "annotation",
    ),
    (
        "beat_meter",
        "beat_meter.lab",
        "Paper-preset beat/meter events",
        "annotation",
    ),
    ("structure", "structure.lab", "Song structure", "annotation"),
    ("key", "key.lab", "Key changes", "annotation"),
    ("chord", "chord.lab", "Chords", "annotation"),
    (
        "melody_full",
        "melody_full.lab",
        "All melody notes",
        "annotation",
    ),
    (
        "melody_vocal",
        "melody_vocal.lab",
        "Vocal melody notes",
        "annotation",
    ),
    (
        "melody_instrumental",
        "melody_instrumental.lab",
        "Instrumental melody notes",
        "annotation",
    ),
    ("melody_midi", "melody.mid", "All melody MIDI", "midi"),
    (
        "melody_vocal_midi",
        "melody_vocal.mid",
        "Vocal melody MIDI",
        "midi",
    ),
    (
        "melody_instrumental_midi",
        "melody_instrumental.mid",
        "Instrumental melody MIDI",
        "midi",
    ),
    ("chords_midi", "chords.mid", "Chord MIDI", "midi"),
];

const RECORDED_SETTINGS: &[&str] = &[
    "prompts",
    "preset",
    "melody_only",
    "dtype",
    "window_seconds",
    "overlap_seconds",
    "lookahead_seconds",
    "duration_seconds",
];

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

fn available_artifacts(run: &Path) -> Result<Vec<Value>, String> {
    let mut result = Vec::new();
    for (id, filename, label, kind) in ARTIFACTS {
        let path = run.join(filename);
        if !path.try_exists().map_err(|e| e.to_string())? {
            continue;
        }
        let path = contained_path(run, &path)?;
        if !path.is_file() {
            return Err("The artifact is not a regular file".to_owned());
        }
        result.push(json!({"id": id, "filename": filename, "label": label, "kind": kind}));
    }
    Ok(result)
}

fn annotation_exports(run: &Path, artifacts: &[Value]) -> Result<Value, String> {
    let mut annotations = serde_json::Map::new();
    for artifact in artifacts {
        if artifact["kind"] == "annotation" {
            let id = artifact["id"]
                .as_str()
                .ok_or("Invalid artifact identifier")?;
            let filename = artifact["filename"]
                .as_str()
                .ok_or("Invalid artifact filename")?;
            annotations.insert(
                id.to_owned(),
                Value::String(read_text(run, &run.join(filename), MAX_EVENT_BYTES)?),
            );
        }
    }
    Ok(Value::Object(annotations))
}

fn recorded_provenance(meta: &Value, result: &Value) -> Value {
    if let Some(provenance) = meta.get("provenance").filter(|value| value.is_object()) {
        return provenance.clone();
    }
    // Old CLI/history runs did not record device or source revisions. Do not
    // retroactively attribute current model pins or CPU settings to those runs.
    let settings: serde_json::Map<String, Value> = RECORDED_SETTINGS
        .iter()
        .filter_map(|key| {
            result
                .get(*key)
                .map(|value| ((*key).to_owned(), value.clone()))
        })
        .collect();
    json!({"recorded_settings": settings})
}

fn score_timing(run: &Path) -> Result<Value, String> {
    // This is the exact notation grid, including its final extrapolated beat.
    // Keep the one fixed nested path inside the existing canonical run boundary.
    let path = run.join("notation/song_beats.txt");
    if !path.try_exists().map_err(|e| e.to_string())? {
        return Ok(Value::Null);
    }
    Ok(json!({
        "version": 1,
        "notation_beats": read_text(run, &path, MAX_EVENT_BYTES)?,
    }))
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
    let artifacts = available_artifacts(&run)?;
    let annotations = annotation_exports(&run, &artifacts)?;
    let provenance = recorded_provenance(&meta, &result);
    let timing = score_timing(&run)?;
    Ok(json!({
        "run_id": id,
        "output_dir": path_string(&run)?,
        "audio_path": path_string(&audio_path)?,
        "audio_name": display_name(&meta, &result),
        "summary": result,
        "abc": abc,
        "playback": playback,
        "events": events,
        "annotations": annotations,
        "available_artifacts": artifacts,
        "provenance": provenance,
        "score_timing": timing,
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
    let filename = ARTIFACTS
        .iter()
        .find(|(id, _, _, _)| *id == artifact)
        .map(|(_, filename, _, _)| *filename)
        .ok_or_else(|| "Unknown artifact identifier".to_owned())?;
    let run = run_directory(root, id)?;
    summary(&run)?;
    let path = contained_path(&run, &run.join(filename))?;
    if !path.is_file() {
        return Err("The artifact is not a regular file".to_owned());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    // macOS clocks may return identical timestamps to concurrent test threads.
    // A shared counter prevents one fixture's Drop from deleting another's root.
    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "sheetsage-catalog-{}-{nonce}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
            ));
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
        assert!(artifact_path(
            &fixture.root,
            "cancelled-20261018T010000000001Z-abcdef12",
            "summary"
        )
        .is_err());

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
    fn all_allowlisted_artifacts_load_and_export_without_arbitrary_paths() {
        let fixture = Fixture::new();
        let run = fixture.run("complete");
        for (id, filename, _, _) in ARTIFACTS {
            if !run.join(filename).exists() {
                fs::write(run.join(filename), format!("0.25\t1.0\t{id}\n")).unwrap();
            }
            assert_eq!(
                artifact_path(&fixture.root, "complete", id).unwrap(),
                run.join(filename)
            );
        }
        let data = load_run(&fixture.root, "complete").unwrap();
        assert_eq!(
            data["available_artifacts"].as_array().unwrap().len(),
            ARTIFACTS.len()
        );
        assert_eq!(data["annotations"].as_object().unwrap().len(), 10);
        assert_eq!(
            data["annotations"]["rhythm_events"],
            "0.25\t1.0\trhythm_events\n"
        );
        assert!(artifact_path(&fixture.root, "complete", "beat.lab").is_err());
        assert!(artifact_path(&fixture.root, "complete", "tokens.json").is_err());
    }

    #[test]
    fn history_preserves_raw_events_empty_annotations_and_recorded_provenance() {
        let fixture = Fixture::new();
        let run = fixture.run("recorded");
        let events = json!({"schema_version":"v1", "events":[{"time":0.25,"values":{
            "rhythm":{"meter":[6,8],"eighth_position":1},
            "melody":[{"pitch":60,"track":0,"end_time":0.75}]
        }}]});
        fs::write(run.join("events.json"), events.to_string()).unwrap();
        fs::write(run.join("melody_instrumental.lab"), "").unwrap();
        let provenance = json!({"device":"cpu","sources":{"model_revision":"pinned"},
            "recorded_settings":{"preset":"default","dtype":"fp32"}});
        fs::write(
            run.join("ui.json"),
            json!({"provenance":provenance}).to_string(),
        )
        .unwrap();
        let data = load_run(&fixture.root, "recorded").unwrap();
        assert_eq!(data["events"], events);
        assert_eq!(data["annotations"], json!({"melody_instrumental":""}));
        assert_eq!(data["provenance"], provenance);
        assert!(data["annotations"].get("beat_meter").is_none());

        fs::remove_file(run.join("ui.json")).unwrap();
        let legacy = load_run(&fixture.root, "recorded").unwrap();
        assert!(legacy["provenance"].get("device").is_none());
        assert!(legacy["provenance"].get("sources").is_none());
        assert_eq!(
            legacy["provenance"]["recorded_settings"]["duration_seconds"],
            20.0
        );
    }

    #[test]
    fn missing_optional_exports_are_not_listed_and_large_annotations_fail() {
        let fixture = Fixture::new();
        let run = fixture.run("optional");
        let data = load_run(&fixture.root, "optional").unwrap();
        assert_eq!(data["annotations"], json!({}));
        assert!(!data["available_artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value["id"] == "beat_meter"));
        assert!(artifact_path(&fixture.root, "optional", "beat_meter").is_err());
        File::create(run.join("beat.lab"))
            .unwrap()
            .set_len(MAX_EVENT_BYTES + 1)
            .unwrap();
        assert!(load_run(&fixture.root, "optional").is_err());
    }

    #[test]
    fn legacy_and_desktop_runs_share_exact_score_timing_and_playback_measures() {
        let fixture = Fixture::new();
        let run = fixture.run("score-timing");
        fs::create_dir(run.join("notation")).unwrap();
        let raw_beats = "0.0\t1\t4\t4\n0.5\t2\t4\t4\n";
        let notation_beats = format!("{raw_beats}1.0\t3\t4\t4\n");
        fs::write(run.join("beat.lab"), raw_beats).unwrap();
        fs::write(run.join("notation/song_beats.txt"), &notation_beats).unwrap();
        let playback = json!({"duration":20, "tracks":[], "measures":[{
            "index":0,"start":0,"end":1,"score_start":0,"score_end":1,
            "leading_rest":0.5,"trailing_rest":0
        }]});
        fs::write(run.join("playback.json"), playback.to_string()).unwrap();
        let legacy = load_run(&fixture.root, "score-timing").unwrap();
        assert_eq!(
            legacy["score_timing"],
            json!({"version":1,"notation_beats":notation_beats})
        );
        assert_eq!(legacy["annotations"]["beat"], raw_beats);
        assert_eq!(legacy["playback"], playback);
        assert!(!legacy["available_artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value["id"] == "score_timing"));

        fs::write(run.join(".desktop-job.json"), "{}").unwrap();
        fs::write(run.join("ui.json"), "{}").unwrap();
        let desktop = load_run(&fixture.root, "score-timing").unwrap();
        assert_eq!(desktop["score_timing"], legacy["score_timing"]);
        assert_eq!(desktop["playback"], legacy["playback"]);
    }

    #[test]
    fn score_timing_is_optional_bounded_and_not_an_arbitrary_export() {
        let fixture = Fixture::new();
        let run = fixture.run("score-timing");
        assert!(load_run(&fixture.root, "score-timing").unwrap()["score_timing"].is_null());
        fs::create_dir(run.join("notation")).unwrap();
        let beats = run.join("notation/song_beats.txt");
        fs::write(&beats, "").unwrap();
        assert_eq!(
            load_run(&fixture.root, "score-timing").unwrap()["score_timing"],
            json!({"version":1,"notation_beats":""})
        );
        assert!(artifact_path(&fixture.root, "score-timing", "notation/song_beats.txt").is_err());
        File::create(&beats)
            .unwrap()
            .set_len(MAX_EVENT_BYTES + 1)
            .unwrap();
        assert!(load_run(&fixture.root, "score-timing").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn nested_score_timing_file_and_directory_symlinks_cannot_escape_run() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        let run = fixture.run("score-timing");
        let notation = run.join("notation");
        fs::create_dir(&notation).unwrap();
        let beats = notation.join("song_beats.txt");
        symlink(outside.root.join("samples/demo.mp3"), &beats).unwrap();
        assert!(load_run(&fixture.root, "score-timing").is_err());
        fs::remove_file(&beats).unwrap();
        fs::remove_dir(&notation).unwrap();
        fs::write(outside.root.join("song_beats.txt"), "0\t1\t4\t4\n").unwrap();
        symlink(&outside.root, &notation).unwrap();
        assert!(load_run(&fixture.root, "score-timing").is_err());
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

    #[cfg(unix)]
    #[test]
    fn new_annotation_and_midi_exports_reject_symlink_escapes() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        let run = fixture.run("safe");
        for (id, filename) in [
            ("beat", "beat.lab"),
            ("melody_vocal_midi", "melody_vocal.mid"),
        ] {
            symlink(outside.root.join("samples/demo.mp3"), run.join(filename)).unwrap();
            assert!(artifact_path(&fixture.root, "safe", id).is_err());
            assert!(load_run(&fixture.root, "safe").is_err());
            fs::remove_file(run.join(filename)).unwrap();
        }
    }
}
