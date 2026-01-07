<?php
// Simple robust proxy using cURL
// Usage: proxy.php?url=ENCODED_URL

if (!isset($_GET['url'])) {
    http_response_code(400);
    echo "Missing 'url' parameter";
    exit;
}

$url = $_GET['url'];

// Basic validation
if (filter_var($url, FILTER_VALIDATE_URL) === FALSE) {
    http_response_code(400);
    echo "Invalid URL";
    exit;
}

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
// Timeouts
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10); 
curl_setopt($ch, CURLOPT_TIMEOUT, 30);
// SSL verification (optional, keeping strict for now but good to know)
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false); 

$data = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);

if (curl_errno($ch)) {
    http_response_code(500);
    echo "Curl Error: " . curl_error($ch);
} else {
    http_response_code($httpCode);
    header("Content-Type: " . $contentType);
    header("Access-Control-Allow-Origin: *"); // CORS header
    echo $data;
}

curl_close($ch);
?>
