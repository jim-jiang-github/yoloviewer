use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "bmp", "webp", "tif", "tiff"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub class_id: usize,
    pub cx: f64,
    pub cy: f64,
    pub w: f64,
    pub h: f64,
    pub confidence: Option<f64>,
    pub label: Option<String>,
    pub object_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    pub name: String,
    pub path: String,
    pub label_path: Option<String>,
    pub rel_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanInit {
    pub root: String,
    pub classes: Vec<String>,
    pub class_source: String,
    pub has_jsonl: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    phase: String,
    indexed: usize,
    total_hint: usize,
    done: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanDone {
    total: usize,
    has_names: bool,
    classes: Vec<String>,
    class_source: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsUpdate {
    total_boxes: u64,
    class_counts: Vec<u64>,
    classes: Vec<String>,
    progress: f64,
    done: bool,
}

#[derive(Default)]
struct WalkResult {
    image_paths: Vec<PathBuf>,
    txt_index: HashMap<String, PathBuf>,
    stem_index: HashMap<String, PathBuf>,
}

#[derive(Default)]
pub struct Dataset {
    root: String,
    images: Vec<ImageMeta>,
    classes: Vec<String>,
    class_source: String,
    jsonl_path: Option<String>,
    jsonl_index: HashMap<String, (u64, u32)>,
    has_names: bool,
    scan_done: bool,
    class_counts: Vec<u64>,
    total_boxes: u64,
}

pub type SharedDataset = Arc<Mutex<Dataset>>;

fn emit_progress(app: &AppHandle, phase: &str, indexed: usize, total_hint: usize, done: bool) {
    let _ = app.emit(
        "scan://progress",
        ScanProgress {
            phase: phase.to_string(),
            indexed,
            total_hint,
            done,
        },
    );
}

/* ---------------- directory indexing (no label contents are read) ---------------- */

fn walk(dir: &Path, base: &Path, result: &mut WalkResult, depth: usize, app: &AppHandle) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            let lower = name.to_ascii_lowercase();
            if matches!(
                lower.as_str(),
                "node_modules" | "__pycache__" | ".git" | "venv" | "runs" | "dist"
            ) {
                continue;
            }
            walk(&path, base, result, depth + 1, app);
        } else if path.is_file() {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if IMAGE_EXTS.contains(&ext.as_str()) {
                result.image_paths.push(path);
                if result.image_paths.len() % 5000 == 0 {
                    emit_progress(app, "scanning", result.image_paths.len(), 0, false);
                }
            } else if ext == "txt" {
                let rel = path
                    .strip_prefix(base)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_ascii_lowercase();
                result
                    .txt_index
                    .entry(rel)
                    .or_insert_with(|| path.clone());
                let stem = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_ascii_lowercase();
                result
                    .stem_index
                    .entry(stem)
                    .or_insert_with(|| path.clone());
            }
        }
    }
}

fn key_of(segments: &[String]) -> String {
    segments.join("/").to_ascii_lowercase()
}

fn resolve_label(
    rel: &str,
    stem: &str,
    index: &WalkResult,
) -> Option<PathBuf> {
    let filename = format!("{}.txt", stem);
    let segments: Vec<String> = rel.split('/').map(|s| s.to_string()).collect();

    // 1. same directory
    let mut candidate = segments.clone();
    if let Some(last) = candidate.last_mut() {
        *last = filename.clone();
    }
    if let Some(path) = index.txt_index.get(&key_of(&candidate)) {
        return Some(path.clone());
    }

    // 2. images/train/x.jpg -> labels/train/x.txt (any "images" component)
    for (i, segment) in segments.iter().enumerate() {
        if segment.eq_ignore_ascii_case("images") {
            let mut alternative = candidate.clone();
            alternative[i] = "labels".to_string();
            if let Some(path) = index.txt_index.get(&key_of(&alternative)) {
                return Some(path.clone());
            }
        }
    }

    // 3. sibling labels/ of the parent directory
    if segments.len() >= 2 {
        let mut alternative = candidate.clone();
        let insert_at = segments.len() - 1;
        alternative.insert(insert_at, "labels".to_string());
        if let Some(path) = index.txt_index.get(&key_of(&alternative)) {
            return Some(path.clone());
        }
    }

    // 4. root-level labels/
    let mut root_labels = vec!["labels".to_string()];
    root_labels.extend(candidate.iter().skip(1).cloned());
    if let Some(path) = index.txt_index.get(&key_of(&root_labels)) {
        return Some(path.clone());
    }
    let root_simple = vec!["labels".to_string(), filename.clone()];
    if let Some(path) = index.txt_index.get(&key_of(&root_simple)) {
        return Some(path.clone());
    }

    // 5. last resort: unique stem match
    index.stem_index.get(&stem.to_ascii_lowercase()).cloned()
}

/* ---------------- label parsing ---------------- */

fn parse_annotation_line(parts: &[&str]) -> Option<Annotation> {
    let class_id = parts.first()?.parse::<usize>().ok()?;
    let annotation = if parts.len() >= 7 {
        let mut min_x = f64::MAX;
        let mut max_x = f64::MIN;
        let mut min_y = f64::MAX;
        let mut max_y = f64::MIN;
        let mut count = 0usize;
        for pair in parts[1..].chunks(2) {
            if pair.len() < 2 {
                break;
            }
            let x = pair[0].parse::<f64>().ok()?;
            let y = pair[1].parse::<f64>().ok()?;
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
            count += 1;
        }
        if count < 3 {
            return None;
        }
        Annotation {
            class_id,
            cx: (min_x + max_x) / 2.0,
            cy: (min_y + max_y) / 2.0,
            w: max_x - min_x,
            h: max_y - min_y,
            confidence: None,
            label: None,
            object_id: None,
        }
    } else {
        if parts.len() < 5 {
            return None;
        }
        Annotation {
            class_id,
            cx: parts[1].parse::<f64>().ok()?,
            cy: parts[2].parse::<f64>().ok()?,
            w: parts[3].parse::<f64>().ok()?,
            h: parts[4].parse::<f64>().ok()?,
            confidence: parts.get(5).and_then(|v| v.parse::<f64>().ok()),
            label: None,
            object_id: None,
        }
    };
    Some(annotation)
}

fn parse_label(path: &Path) -> Vec<Annotation> {
    let mut annotations = Vec::new();
    let Ok(content) = fs::read_to_string(path) else {
        return annotations;
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if let Some(annotation) = parse_annotation_line(&parts) {
            annotations.push(annotation);
        }
    }
    annotations
}

/* ---------------- class names ---------------- */

fn clean_name(value: &str) -> String {
    value
        .split('#')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(|c| c == '\'' || c == '"')
        .trim()
        .to_string()
}

fn parse_yaml_names(text: &str) -> Option<Vec<String>> {
    let lines: Vec<&str> = text.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("names:") {
            continue;
        }
        let indent = line.len() - trimmed.len();
        let rest = trimmed["names:".len()..].trim();
        if !rest.is_empty() {
            if rest.starts_with('[') && rest.ends_with(']') {
                let inner = &rest[1..rest.len() - 1];
                let names: Vec<String> = inner
                    .split(',')
                    .map(clean_name)
                    .filter(|s| !s.is_empty())
                    .collect();
                if !names.is_empty() {
                    return Some(names);
                }
            }
            continue;
        }
        let mut names = Vec::new();
        for next in lines.iter().skip(i + 1) {
            let content = next.trim();
            if content.is_empty() || content.starts_with('#') {
                continue;
            }
            if next.len() - next.trim_start().len() <= indent {
                break;
            }
            if let Some(value) = content.strip_prefix("- ") {
                let name = clean_name(value);
                if !name.is_empty() {
                    names.push(name);
                }
            } else if let Some((key, value)) = content.split_once(':') {
                if key.trim().parse::<usize>().is_ok() {
                    let name = clean_name(value);
                    if !name.is_empty() {
                        names.push(name);
                    }
                }
            }
        }
        if !names.is_empty() {
            return Some(names);
        }
    }
    None
}

fn parse_class_file(path: &Path) -> Option<Vec<String>> {
    let text = fs::read_to_string(path).ok()?;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "yaml" || ext == "yml" {
        parse_yaml_names(&text)
    } else {
        let names: Vec<String> = text
            .lines()
            .map(clean_name)
            .filter(|s| !s.is_empty())
            .collect();
        if names.is_empty() {
            None
        } else {
            Some(names)
        }
    }
}

fn load_classes(root: &Path) -> (Vec<String>, String) {
    let mut candidates = vec![
        root.join("classes.txt"),
        root.join("obj.names"),
        root.join("data.yaml"),
        root.join("data.yml"),
        root.join("labels").join("classes.txt"),
        root.join("labels").join("data.yaml"),
    ];
    if let Some(parent) = root.parent() {
        candidates.push(parent.join("classes.txt"));
        candidates.push(parent.join("obj.names"));
        candidates.push(parent.join("data.yaml"));
        candidates.push(parent.join("data.yml"));
    }
    for path in candidates {
        if path.is_file() {
            if let Some(names) = parse_class_file(&path) {
                return (
                    names,
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
    }
    (vec!["类别 0".to_string()], "自动生成".to_string())
}

/* ---------------- annotations.jsonl (streaming, per-file lookup) ---------------- */

fn extract_file_field(line: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(line).ok()?;
    let key = text.find("\"file\"")?;
    let after_key = &text[key + 6..];
    let colon = after_key.find(':')?;
    let after_colon = &after_key[colon + 1..];
    let quote = after_colon.find('"')?;
    let value = &after_colon[quote + 1..];
    let end = value.find('"')?;
    Some(value[..end].to_string())
}

fn build_jsonl_index(path: &Path, shared: &SharedDataset, app: &AppHandle) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let mut reader = BufReader::new(file);
    let mut buffer: Vec<u8> = Vec::new();
    let mut offset = 0u64;
    let mut count = 0usize;
    let mut index = HashMap::new();
    loop {
        buffer.clear();
        let read = match reader.read_until(b'\n', &mut buffer) {
            Ok(n) => n,
            Err(_) => break,
        };
        if read == 0 {
            break;
        }
        if let Some(rel) = extract_file_field(&buffer) {
            let key = rel.replace('\\', "/").to_ascii_lowercase();
            index.insert(key, (offset, read as u32));
        }
        offset += read as u64;
        count += 1;
        if count % 10000 == 0 {
            emit_progress(app, "jsonl", count, count, false);
        }
    }
    if let Ok(mut dataset) = shared.lock() {
        dataset.has_names = !index.is_empty();
        dataset.jsonl_index = index;
    }
}

#[derive(Deserialize)]
struct JsonlBox {
    name: Option<String>,
    id: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct JsonlRow {
    #[serde(default)]
    boxes: Vec<JsonlBox>,
}

fn read_jsonl_names(path: &Path, offset: u64, length: u32) -> Option<Vec<(Option<String>, Option<String>)>> {
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut buffer = vec![0u8; length as usize];
    file.read_exact(&mut buffer).ok()?;
    let row: JsonlRow = serde_json::from_slice(&buffer).ok()?;
    Some(
        row.boxes
            .into_iter()
            .map(|item| {
                let id = item.id.map(|value| match value {
                    serde_json::Value::String(text) => text,
                    other => other.to_string(),
                });
                (item.name, id)
            })
            .collect(),
    )
}

/* ---------------- background statistics ---------------- */

fn run_statistics(shared: &SharedDataset, app: &AppHandle) {
    let label_paths: Vec<Option<String>> = {
        let dataset = match shared.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        dataset
            .images
            .iter()
            .map(|image| image.label_path.clone())
            .collect()
    };
    let total_images = label_paths.len();
    if total_images == 0 {
        emit_stats(app, 0, Vec::new(), Vec::new(), 1.0, true);
        return;
    }

    let mut counts: Vec<u64> = Vec::new();
    let mut total_boxes = 0u64;
    for (i, label) in label_paths.iter().enumerate() {
        if let Some(path) = label {
            for annotation in parse_label(Path::new(path)) {
                while counts.len() <= annotation.class_id {
                    counts.push(0);
                }
                counts[annotation.class_id] += 1;
                total_boxes += 1;
            }
        }
        if i % 5000 == 4999 {
            let classes = {
                let mut dataset = match shared.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                while dataset.classes.len() < counts.len() {
                    let next = dataset.classes.len();
                    dataset.classes.push(format!("类别 {}", next));
                }
                dataset.class_counts = counts.clone();
                dataset.total_boxes = total_boxes;
                dataset.classes.clone()
            };
            emit_stats(
                app,
                total_boxes,
                counts.clone(),
                classes,
                (i + 1) as f64 / total_images as f64,
                false,
            );
        }
    }
    let classes = {
        let mut dataset = match shared.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        while dataset.classes.len() < counts.len() {
            let next = dataset.classes.len();
            dataset.classes.push(format!("类别 {}", next));
        }
        dataset.class_counts = counts.clone();
        dataset.total_boxes = total_boxes;
        dataset.classes.clone()
    };
    emit_stats(app, total_boxes, counts, classes, 1.0, true);
}

fn emit_stats(
    app: &AppHandle,
    total_boxes: u64,
    class_counts: Vec<u64>,
    classes: Vec<String>,
    progress: f64,
    done: bool,
) {
    let _ = app.emit(
        "stats://update",
        StatsUpdate {
            total_boxes,
            class_counts,
            classes,
            progress,
            done,
        },
    );
}

/* ---------------- progressive scan pipeline ---------------- */

fn natural_cmp(a: &str, b: &str) -> Ordering {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let (mut i, mut j) = (0, 0);
    while i < ab.len() && j < bb.len() {
        if ab[i].is_ascii_digit() && bb[j].is_ascii_digit() {
            let (start_a, start_b) = (i, j);
            while i < ab.len() && ab[i].is_ascii_digit() {
                i += 1;
            }
            while j < bb.len() && bb[j].is_ascii_digit() {
                j += 1;
            }
            let num_a = a[start_a..i].trim_start_matches('0');
            let num_b = b[start_b..j].trim_start_matches('0');
            let order = num_a.len().cmp(&num_b.len()).then_with(|| num_a.cmp(num_b));
            if order != Ordering::Equal {
                return order;
            }
        } else {
            let order = ab[i].cmp(&bb[j]);
            if order != Ordering::Equal {
                return order;
            }
            i += 1;
            j += 1;
        }
    }
    ab.len().cmp(&bb.len())
}

fn run_scan(root: PathBuf, shared: SharedDataset, app: AppHandle) {
    let mut walked = WalkResult::default();
    walk(&root, &root, &mut walked, 0, &app);
    emit_progress(&app, "sorting", walked.image_paths.len(), 0, false);

    walked.image_paths.sort_by(|a, b| {
        let name_a = a.file_name().unwrap_or_default().to_string_lossy().to_string();
        let name_b = b.file_name().unwrap_or_default().to_string_lossy().to_string();
        natural_cmp(&name_a, &name_b)
    });

    let mut images = Vec::with_capacity(walked.image_paths.len());
    for path in &walked.image_paths {
        let rel = path
            .strip_prefix(&root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let stem = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let label = resolve_label(&rel, &stem, &walked);
        images.push(ImageMeta {
            name,
            path: path.to_string_lossy().to_string(),
            label_path: label.map(|value| value.to_string_lossy().to_string()),
            rel_path: rel,
        });
    }
    let total = images.len();
    if let Ok(mut dataset) = shared.lock() {
        dataset.images = images;
    }
    emit_progress(&app, "images-ready", total, total, false);

    let jsonl_path = shared
        .lock()
        .ok()
        .and_then(|dataset| dataset.jsonl_path.clone());
    if let Some(path) = jsonl_path {
        build_jsonl_index(Path::new(&path), &shared, &app);
    }

    emit_progress(&app, "stats", total, total, false);
    run_statistics(&shared, &app);

    let (classes, class_source, has_names) = {
        let mut dataset = match shared.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        dataset.scan_done = true;
        (
            dataset.classes.clone(),
            dataset.class_source.clone(),
            dataset.has_names,
        )
    };
    let _ = app.emit(
        "scan://done",
        ScanDone {
            total,
            has_names,
            classes,
            class_source,
        },
    );
}

/* ---------------- commands ---------------- */

#[tauri::command]
fn scan_folder(
    path: String,
    app: AppHandle,
    state: State<'_, SharedDataset>,
) -> Result<ScanInit, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("所选路径不是有效文件夹".to_string());
    }
    let (classes, class_source) = load_classes(&root);
    let jsonl = root.join("annotations.jsonl");
    let jsonl_path = if jsonl.is_file() {
        Some(jsonl.to_string_lossy().to_string())
    } else {
        None
    };
    {
        let mut dataset = state.lock().map_err(|error| error.to_string())?;
        *dataset = Dataset {
            root: path.clone(),
            classes: classes.clone(),
            class_source: class_source.clone(),
            jsonl_path: jsonl_path.clone(),
            ..Default::default()
        };
    }
    let shared = state.inner().clone();
    let root_for_thread = root.clone();
    std::thread::spawn(move || run_scan(root_for_thread, shared, app));
    Ok(ScanInit {
        root: path,
        classes,
        class_source,
        has_jsonl: jsonl_path.is_some(),
    })
}

#[tauri::command]
fn get_image_batch(
    indices: Vec<usize>,
    state: State<'_, SharedDataset>,
) -> Result<Vec<Option<ImageMeta>>, String> {
    let dataset = state.lock().map_err(|error| error.to_string())?;
    Ok(indices
        .into_iter()
        .map(|index| dataset.images.get(index).cloned())
        .collect())
}

#[tauri::command]
fn search_images(
    query: String,
    state: State<'_, SharedDataset>,
) -> Result<Vec<usize>, String> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let dataset = state.lock().map_err(|error| error.to_string())?;
    Ok(dataset
        .images
        .iter()
        .enumerate()
        .filter(|(_, image)| image.name.to_ascii_lowercase().contains(&needle))
        .map(|(index, _)| index)
        .collect())
}

#[tauri::command]
fn get_annotations(
    index: usize,
    state: State<'_, SharedDataset>,
) -> Result<Vec<Annotation>, String> {
    let (label_path, jsonl_path, jsonl_entry) = {
        let dataset = state.lock().map_err(|error| error.to_string())?;
        let image = dataset.images.get(index).ok_or("图片索引越界")?;
        let key = image.rel_path.replace('\\', "/").to_ascii_lowercase();
        (
            image.label_path.clone(),
            dataset.jsonl_path.clone(),
            dataset.jsonl_index.get(&key).copied(),
        )
    };

    let mut annotations = label_path
        .as_ref()
        .map(|path| parse_label(Path::new(path)))
        .unwrap_or_default();

    if let (Some(jsonl), Some((offset, length))) = (jsonl_path, jsonl_entry) {
        if let Some(names) = read_jsonl_names(Path::new(&jsonl), offset, length) {
            for (i, annotation) in annotations.iter_mut().enumerate() {
                if let Some((name, id)) = names.get(i) {
                    annotation.label = name.clone();
                    annotation.object_id = id.clone();
                }
            }
        }
    }
    Ok(annotations)
}

#[tauri::command]
fn startup_path() -> Option<String> {
    std::env::args().nth(1)
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SharedDataset::default())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            get_image_batch,
            search_images,
            get_annotations,
            startup_path,
            reveal_in_explorer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
