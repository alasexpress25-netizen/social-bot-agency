<?php
// upload.php — recibe un archivo del panel de agencia y lo guarda en
// images/<carpeta>/, creando la carpeta si no existe. Devuelve la URL
// pública del archivo guardado.
//
// Se sube tal cual a public_html/publicar/upload.php (mismo nivel que
// index.html en esa carpeta).

header('Content-Type: application/json');

// --- Config -----------------------------------------------------------
const UPLOAD_TOKEN = 'accc75453220c8f997e3a7274eadede22e0c3bd347d18303'; // debe matchear UPLOAD_TOKEN en index.html
const BASE_URL = 'https://lavisualmk.alastecno.com/publicar/images/';
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;  // 15MB
$ALLOWED_EXT = [
    'mp4' => 'video', 'mov' => 'video',
    'jpg' => 'image', 'jpeg' => 'image', 'png' => 'image', 'webp' => 'image',
];

function fail($msg, $code = 400) {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

// --- Auth ---------------------------------------------------------------
$token = $_SERVER['HTTP_X_UPLOAD_TOKEN'] ?? '';
if ($token !== UPLOAD_TOKEN) {
    fail('No autorizado', 401);
}

// --- Borrado de un archivo ya subido --------------------------------------
// El panel manda action=delete + folder + filename cuando el usuario quiere
// borrar un archivo (por ejemplo si subió el equivocado y todavía no lo usó
// en "Medios"). basename() evita que filename pueda salirse de la carpeta
// del cliente (ej: "../../otra_cosa.php").
if (($_POST['action'] ?? '') === 'delete') {
    $folder = preg_replace('/[^a-zA-Z0-9_-]/', '', $_POST['folder'] ?? '');
    $filename = basename($_POST['filename'] ?? '');
    if ($folder === '' || $filename === '') {
        fail('Falta folder o filename');
    }

    $path = __DIR__ . '/images/' . $folder . '/' . $filename;
    if (!file_exists($path)) {
        fail('El archivo no existe (puede que ya lo hayan borrado)', 404);
    }
    if (!unlink($path)) {
        fail('No se pudo borrar el archivo', 500);
    }

    echo json_encode(['deleted' => true]);
    exit;
}

// --- Listado de archivos ya subidos ---------------------------------------
// El panel manda action=list + folder cuando el usuario abre la pestaña
// "Archivos en Host", para ver (y poder borrar) lo que ya está guardado en
// Hostinger para ese cliente. Misma sanitización de folder que en delete.
if (($_POST['action'] ?? '') === 'list') {
    $folder = preg_replace('/[^a-zA-Z0-9_-]/', '', $_POST['folder'] ?? '');
    if ($folder === '') {
        fail('Falta folder');
    }

    $dir = __DIR__ . '/images/' . $folder;
    if (!is_dir($dir)) {
        echo json_encode(['files' => []]);
        exit;
    }

    $files = [];
    foreach (scandir($dir) as $name) {
        if ($name === '.' || $name === '..') continue;
        $path = $dir . '/' . $name;
        if (!is_file($path)) continue;

        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if (!isset($ALLOWED_EXT[$ext])) continue; // ignora archivos sueltos que no sean de estos tipos

        $files[] = [
            'name' => $name,
            'url' => BASE_URL . $folder . '/' . $name,
            'media_type' => $ALLOWED_EXT[$ext],
            'size' => filesize($path),
            'mtime' => filemtime($path),
        ];
    }

    usort($files, fn($a, $b) => $b['mtime'] <=> $a['mtime']); // más nuevos primero
    echo json_encode(['files' => $files]);
    exit;
}

// --- Validaciones ---------------------------------------------------------
if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    fail('Falta el archivo o hubo un error al subirlo (código: ' . ($_FILES['file']['error'] ?? 'ninguno') . ')');
}

$folder = preg_replace('/[^a-zA-Z0-9_-]/', '', $_POST['folder'] ?? '');
if ($folder === '') {
    fail('Falta folder (page_id de la cuenta social del cliente)');
}

$originalName = $_FILES['file']['name'];
$ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
if (!isset($ALLOWED_EXT[$ext])) {
    fail('Extensión no permitida: ' . $ext);
}

$tipo = $ALLOWED_EXT[$ext];
$maxBytes = $tipo === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
if ($_FILES['file']['size'] > $maxBytes) {
    fail('Archivo demasiado grande (máximo ' . ($maxBytes / 1024 / 1024) . 'MB para ' . $tipo . ')');
}

// --- Guardado -------------------------------------------------------------
$dir = __DIR__ . '/images/' . $folder;
if (!is_dir($dir)) {
    if (!mkdir($dir, 0755, true)) {
        fail('No se pudo crear la carpeta del cliente', 500);
    }
}

// Nombre único: timestamp + nombre original saneado, para no pisar archivos
// existentes si suben dos cosas con el mismo nombre.
$safeName = preg_replace('/[^a-zA-Z0-9._-]/', '_', $originalName);
$finalName = time() . '_' . $safeName;
$destPath = $dir . '/' . $finalName;

if (!move_uploaded_file($_FILES['file']['tmp_name'], $destPath)) {
    fail('No se pudo guardar el archivo en el servidor', 500);
}

echo json_encode([
    'url' => BASE_URL . $folder . '/' . $finalName,
    'media_type' => $tipo,
]);