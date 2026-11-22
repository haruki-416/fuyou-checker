<?php
/**
 * 扶養チェッカー 同期API（暗号文を保管するだけ）
 *
 * サーバーが受け取るのは「同期ID」「認証トークン」「暗号文」だけです。
 * パスワードと暗号鍵はブラウザから出ないので、サーバー管理者にも中身は読めません。
 *
 * POST JSON:
 *   {"action":"get", "id":"...", "token":"..."}
 *   {"action":"put", "id":"...", "token":"...", "baseRev":3, "payload":{...}, "force":false}
 *   {"action":"delete", "id":"...", "token":"..."}
 *   {"action":"handoff_put", "id":"...", "token":"...", "hid":"...", "blob":{...}}  // スマホ用の使い捨てリンク
 *   {"action":"handoff_take", "hid":"..."}                                          // 1回受け取ると消える
 *
 * 必要: PHP 7.4 以上 / HTTPS 推奨（必須）
 */

declare(strict_types=1);

// ===== 設定 =====
// データの保存先。可能なら公開フォルダ（public_html など）の外を指定してください。
// 例: define('FUYOU_DATA_DIR', '/home/youruser/fuyou-data');
if (!defined('FUYOU_DATA_DIR')) {
    $cfg = __DIR__ . '/config.php'; // 任意: config.php に define を書けば上書きできる
    if (is_file($cfg)) require $cfg;
}
if (!defined('FUYOU_DATA_DIR')) define('FUYOU_DATA_DIR', dirname(__DIR__) . '/data');
const MAX_BYTES = 1048576;      // 1件あたり最大1MB
const MAX_FAILS_PER_HOUR = 20;  // 同じIPからの認証失敗の上限
const HANDOFF_TTL = 600;        // スマホ用リンクの有効期限（秒）

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function out(int $code, array $body): void {
    http_response_code($code);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') out(405, ['ok' => false, 'error' => 'POSTのみ対応しています']);

$raw = file_get_contents('php://input', false, null, 0, MAX_BYTES + 4096);
if ($raw === false || strlen($raw) > MAX_BYTES) out(413, ['ok' => false, 'error' => 'データが大きすぎます']);
$req = json_decode($raw, true);
if (!is_array($req)) out(400, ['ok' => false, 'error' => 'JSONが不正です']);

$action = (string)($req['action'] ?? '');

// ----- スマホ用リンクの受け取り（ID・トークン不要。中身は暗号文で、鍵はリンクの # 以降にしかない） -----
if ($action === 'handoff_take') {
    $hid = (string)($req['hid'] ?? '');
    if (!preg_match('/^[0-9a-f]{32}$/', $hid)) out(400, ['ok' => false, 'error' => 'リンクが不正です']);
    $hfile = FUYOU_DATA_DIR . "/handoff-$hid.json";
    // 期限切れを掃除
    foreach (glob(FUYOU_DATA_DIR . '/handoff-*.json') ?: [] as $f) {
        if (filemtime($f) < time() - HANDOFF_TTL) @unlink($f);
    }
    $tmp = $hfile . '.taking-' . bin2hex(random_bytes(4));
    if (!is_file($hfile) || !@rename($hfile, $tmp)) out(410, ['ok' => false, 'error' => 'このリンクは使用済みか、期限切れです。PCでもう一度作ってください']);
    $doc = json_decode((string)file_get_contents($tmp), true);
    @unlink($tmp);
    if (!is_array($doc) || ($doc['expires'] ?? 0) < time()) out(410, ['ok' => false, 'error' => 'このリンクは期限切れです。PCでもう一度作ってください']);
    out(200, ['ok' => true, 'blob' => $doc['blob']]);
}

$id = (string)($req['id'] ?? '');
$token = (string)($req['token'] ?? '');
if (!preg_match('/^[0-9a-f]{32}$/', $id)) out(400, ['ok' => false, 'error' => '同期IDが不正です']);
if (!preg_match('/^[0-9a-f]{64}$/', $token)) out(400, ['ok' => false, 'error' => 'トークンが不正です']);

// ----- 保存先の準備 -----
$dir = FUYOU_DATA_DIR;
if (!is_dir($dir) && !@mkdir($dir, 0700, true)) out(500, ['ok' => false, 'error' => '保存フォルダを作れません（FUYOU_DATA_DIR の権限を確認）']);
if (!is_file("$dir/.htaccess")) @file_put_contents("$dir/.htaccess", "Require all denied\nDeny from all\n");
if (!is_file("$dir/index.html")) @file_put_contents("$dir/index.html", '');

// ----- 総当たり対策（IPごとの失敗回数） -----
$ipKey = hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? '') . '|fuyou');
$failFile = "$dir/fails-" . substr($ipKey, 0, 24) . '.json';
$fails = is_file($failFile) ? (json_decode((string)file_get_contents($failFile), true) ?: []) : [];
$fails = array_values(array_filter($fails, fn($t) => $t > time() - 3600));
if (count($fails) >= MAX_FAILS_PER_HOUR) out(429, ['ok' => false, 'error' => '失敗が多すぎます。1時間ほど待ってください']);
function recordFail(string $file, array $fails): void {
    $fails[] = time();
    @file_put_contents($file, json_encode($fails), LOCK_EX);
    usleep(400000);
}

// ----- 対象ファイルをロックして処理 -----
$file = "$dir/sync-$id.json";
$fp = fopen($file, 'c+');
if (!$fp) out(500, ['ok' => false, 'error' => '保存ファイルを開けません']);
flock($fp, LOCK_EX);
$cur = stream_get_contents($fp);
$doc = $cur ? json_decode($cur, true) : null;
$exists = is_array($doc);

function finish($fp, int $code, array $body): void {
    flock($fp, LOCK_UN);
    fclose($fp);
    out($code, $body);
}

if ($exists && !password_verify($token, (string)$doc['tokenHash'])) {
    recordFail($failFile, $fails);
    finish($fp, 403, ['ok' => false, 'error' => 'パスワードが違います']);
}

switch ($action) {
    case 'get':
        if (!$exists) { fclose($fp); @unlink($file); out(404, ['ok' => false, 'error' => 'まだサーバーにデータがありません']); }
        finish($fp, 200, ['ok' => true, 'rev' => $doc['rev'], 'updatedAt' => $doc['updatedAt'], 'payload' => $doc['payload']]);

    case 'put':
        $payload = $req['payload'] ?? null;
        if (!is_array($payload) || !isset($payload['iv'], $payload['ct']) || !is_string($payload['ct'])) {
            finish($fp, 400, ['ok' => false, 'error' => '暗号文の形式が不正です']);
        }
        $baseRev = (int)($req['baseRev'] ?? 0);
        $force = !empty($req['force']);
        $rev = $exists ? (int)$doc['rev'] : 0;
        if ($exists && !$force && $baseRev !== $rev) {
            finish($fp, 409, ['ok' => false, 'error' => '別の端末で先に更新されています', 'rev' => $rev, 'updatedAt' => $doc['updatedAt']]);
        }
        $new = [
            'rev' => $rev + 1,
            'updatedAt' => gmdate('c'),
            'tokenHash' => $exists ? $doc['tokenHash'] : password_hash($token, PASSWORD_DEFAULT),
            'payload' => ['cipher' => (string)($payload['cipher'] ?? 'AES-GCM'), 'v' => (int)($payload['v'] ?? 1), 'iv' => (string)$payload['iv'], 'ct' => $payload['ct']],
        ];
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($new, JSON_UNESCAPED_SLASHES));
        fflush($fp);
        @chmod($file, 0600);
        finish($fp, 200, ['ok' => true, 'rev' => $new['rev'], 'updatedAt' => $new['updatedAt']]);

    case 'handoff_put':
        if (!$exists) finish($fp, 404, ['ok' => false, 'error' => '先にサーバーに保存してください']);
        $hid = (string)($req['hid'] ?? '');
        $blob = $req['blob'] ?? null;
        if (!preg_match('/^[0-9a-f]{32}$/', $hid) || !is_array($blob) || !isset($blob['iv'], $blob['ct']) || strlen((string)$blob['ct']) > 4096) {
            finish($fp, 400, ['ok' => false, 'error' => 'リンクのデータが不正です']);
        }
        $expires = time() + HANDOFF_TTL;
        $hfile = "$dir/handoff-$hid.json";
        @file_put_contents($hfile, json_encode(['expires' => $expires, 'blob' => ['iv' => (string)$blob['iv'], 'ct' => (string)$blob['ct']]]), LOCK_EX);
        @chmod($hfile, 0600);
        finish($fp, 200, ['ok' => true, 'expires' => gmdate('c', $expires)]);

    case 'delete':
        if (!$exists) { fclose($fp); @unlink($file); out(404, ['ok' => false, 'error' => 'データがありません']); }
        ftruncate($fp, 0);
        flock($fp, LOCK_UN);
        fclose($fp);
        @unlink($file);
        out(200, ['ok' => true]);

    default:
        if (!$exists) { fclose($fp); @unlink($file); }
        else finish($fp, 400, ['ok' => false, 'error' => 'actionが不正です']);
        out(400, ['ok' => false, 'error' => 'actionが不正です']);
}
