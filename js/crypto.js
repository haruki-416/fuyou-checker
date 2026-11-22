/**
 * 扶養チェッカー 暗号化（ブラウザ内で完結。パスワードはどこにも送らない）
 *
 *  - 暗号: AES-GCM 256bit
 *  - 鍵の導出: PBKDF2-SHA256 600,000回
 *  - バックアップ: ファイルごとにランダムな salt / iv
 *  - サーバー同期: パスワードと同期IDから「暗号鍵」と「認証トークン」を別々に導出。
 *    サーバーに渡るのは認証トークンと暗号文だけで、暗号鍵・パスワード・中身は渡らない。
 */
(function (root) {
  'use strict';
  const subtle = root.crypto && root.crypto.subtle;
  const ITER = 600000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const b64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const rand = (n) => root.crypto.getRandomValues(new Uint8Array(n));

  function available() {
    return !!subtle;
  }
  function assertAvailable() {
    if (!subtle) throw new Error('この画面では暗号化が使えません（https:// で開いてください。localhost も可）');
  }

  async function pbkdf2Bits(password, salt, bits, iterations = ITER) {
    const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    return subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, bits);
  }
  const importAes = (raw, extractable = false) => subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);

  async function aesEncrypt(key, obj) {
    const iv = rand(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function aesDecrypt(key, iv, ct) {
    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
      return JSON.parse(dec.decode(pt));
    } catch (e) {
      throw new Error('復号できませんでした（パスワードが違うか、ファイルが壊れています）');
    }
  }

  // ---------- 暗号化バックアップ（パスワード付きファイル） ----------
  async function encryptBackup(obj, password) {
    assertAvailable();
    if (!password || password.length < 8) throw new Error('パスワードは8文字以上にしてください');
    const salt = rand(16);
    const key = await importAes(await pbkdf2Bits(password, salt, 256));
    const { iv, ct } = await aesEncrypt(key, obj);
    return { format: 'fuyou-checker-encrypted', v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITER, salt: b64(salt) }, cipher: 'AES-GCM', iv, ct };
  }
  function isEncryptedBackup(obj) {
    return obj && obj.format === 'fuyou-checker-encrypted';
  }
  async function decryptBackup(envelope, password) {
    assertAvailable();
    if (!isEncryptedBackup(envelope)) throw new Error('暗号化バックアップの形式ではありません');
    const k = envelope.kdf || {};
    const key = await importAes(await pbkdf2Bits(password, unb64(k.salt), 256, k.iterations || ITER));
    return aesDecrypt(key, envelope.iv, envelope.ct);
  }

  // ---------- サーバー同期 ----------
  /** ランダムな同期ID（32文字の16進数）。他の端末にはこのIDとパスワードを入れる */
  function newSyncId() {
    return hex(rand(16));
  }
  /**
   * パスワード＋同期ID → { keyRaw(base64), token(hex) }
   * 512bit を導出して前半を暗号鍵、後半を認証トークンにする（トークンから鍵は分からない）
   */
  async function deriveSync(password, syncId) {
    assertAvailable();
    if (!password || password.length < 8) throw new Error('同期パスワードは8文字以上にしてください');
    const bits = new Uint8Array(await pbkdf2Bits(password, enc.encode('fuyou-checker-sync:' + syncId), 512));
    return { keyRaw: b64(bits.slice(0, 32)), token: hex(bits.slice(32)) };
  }
  async function encryptForSync(obj, keyRaw) {
    const key = await importAes(unb64(keyRaw));
    return { cipher: 'AES-GCM', v: 1, ...(await aesEncrypt(key, obj)) };
  }
  async function decryptFromSync(payload, keyRaw) {
    const key = await importAes(unb64(keyRaw));
    return aesDecrypt(key, payload.iv, payload.ct);
  }

  // ---------- スマホ用の使い捨てリンク ----------
  const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  /**
   * 同期の鍵を、使い捨ての鍵 k で暗号化する。
   * サーバーには hid と暗号文（blob）だけを置き、k はリンクの # 以降にだけ入れる。
   */
  async function makeHandoff(info) {
    assertAvailable();
    const kRaw = rand(32);
    const key = await importAes(kRaw);
    const blob = await aesEncrypt(key, { id: info.id, keyRaw: info.keyRaw, token: info.token });
    return { hid: hex(rand(16)), k: b64url(kRaw), blob };
  }
  async function openHandoff(blob, k) {
    assertAvailable();
    const key = await importAes(unb64url(k));
    return aesDecrypt(key, blob.iv, blob.ct);
  }

  root.FuyouCrypto = { available, encryptBackup, decryptBackup, isEncryptedBackup, newSyncId, deriveSync, encryptForSync, decryptFromSync, makeHandoff, openHandoff };
})(typeof window !== 'undefined' ? window : globalThis);
