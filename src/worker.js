/**
 * SUUMOの反響通知メールを見張り、届いていたら GitHub Actions を起動する（Cloudflare Worker）。
 *
 * 【流れ】
 * 1. 5分おき（Cron Trigger）に system.ss@pure-growth.net の Gmail を探す
 * 2. 反響通知（SUUMOから届き、本文にダウンロードリンクがあるもの）を見つけたら、
 *    本文の「貴社コード」でブランドを判定し、そのリポジトリを起動する
 *    → メールに「SUUMO起動中」ラベルを付ける（同じメールで二度起動しない）
 * 3. 次の巡回以降で GitHub の実行結果を確かめる
 *    成功 → ★ と「SUUMO取込済」ラベルを付け、「SUUMO起動中」を外す
 *           さらに、そのメールのスレッドに「取込済メモ」（問合せ日時など）を1通追加する
 *    失敗 → 「SUUMO起動中」を外すだけ。次の巡回でもう一度起動する
 *
 * 【★のルール】
 *   ★は「顧客情報のダウンロードまで済んだ」印。GitHubを起動しただけでは付けない。
 *
 * 【取込済メモ】
 *   通知本文の「問合せ日時」（例: 2026年10月 1日14時24分27秒）を読み取り、
 *   「どの反響が取込済みか」をスレッドを開けば分かるようにする。
 *   メモは system.ss の受信箱に置くだけで、誰にも送信しない。
 *   メモの追加に失敗しても、★とラベルはそのまま付ける。
 *
 * 【必要なシークレット】（Cloudflare の Settings → Variables and Secrets）
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN … Gmail を読む・★を付ける鍵
 *   GITHUB_TOKEN … Contents: Read and write と Actions: Read-only が付いたトークン
 *   TEST_KEY     … 動作確認用URLの合言葉（好きな長い文字列）
 */

// ---- 設定 ----------------------------------------------------------

// 貴社コード → 起動するリポジトリ。ブランドが増えたらここに1行足す。
// 貴社コードは反響通知メール本文の「貴社コード：」の番号（= HONEYのダウンロードファイル名の先頭6桁）。
const COMPANIES = {
  '501482': 'thino-lab/yamaka_only-home', // 株式会社ヤマカ木材（オンリーホーム）
  '130967': 'thino-lab/yamaka_naturie',   // 株式会社ヤマカ木材（ナチュリエ）
};

// 反響通知の差出人。
//   hankyo@housingnavi.jp           … SUUMO本体（ナチュリエなど。自動転送されたものもこのまま届く）
//   onlyhome_honey@googlegroups.com … オンリーホーム。Googleグループ経由なので差出人がグループになる
const ALLOWED_FROM = ['hankyo@housingnavi.jp', 'onlyhome_honey@googlegroups.com'];

const MARKER = '/house/hj/operation/download'; // 本文にこのリンクがあるものだけ対象
const LABEL_DONE = 'SUUMO取込済';   // ダウンロードまで済んだ目印（★と一緒に付ける）
const LABEL_PENDING = 'SUUMO起動中'; // GitHubを起動し、結果を待っている目印
const LOOKBACK = '2d';   // さかのぼって探す範囲
const GIVEUP_MIN = 60;   // 起動からこの分数たっても実行が見つからなければ起動し直す
const MEMO_FROM = 'system.ss@pure-growth.net'; // 取込済メモの差出人表示（送信はしない）

// --------------------------------------------------------------------

export default {
  // Cron Trigger（5分おき）から呼ばれる本体
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, { dryRun: false }).catch(e => console.error(`止まりました: ${e.message}`)));
  },

  // 動作確認用。https://<worker>.workers.dev/check?key=<TEST_KEY>
  //   /check        … 見つかったメールを一覧で返すだけ。GitHubもラベルも触らない（安全）
  //   /check?run=1  … 本番と同じ処理を今すぐ1回実行する
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/check') return new Response('not found', { status: 404 });
    if (!env.TEST_KEY || url.searchParams.get('key') !== env.TEST_KEY) {
      return new Response('forbidden', { status: 403 });
    }
    let result, status = 200;
    try {
      result = await run(env, { dryRun: url.searchParams.get('run') !== '1' });
    } catch (e) {
      // どこで止まったかを画面に出す。鍵の中身は含めない
      status = 500;
      result = { error: e.message, hint: hintFor(e.message), secrets: secretStatus(env) };
    }
    return new Response(JSON.stringify(result, null, 2), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  },
};

/** Secret が登録されているかだけを返す（値は出さない） */
function secretStatus(env) {
  const names = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GITHUB_TOKEN', 'TEST_KEY'];
  return Object.fromEntries(names.map(n => [n, env[n] ? `登録あり（${String(env[n]).length}文字）` : '未登録']));
}

function hintFor(msg) {
  if (/invalid_grant/.test(msg)) return 'Refresh token が使えません。貼り間違い、または別のクライアントIDで発行した鍵の可能性。OAuth Playground で発行し直してください';
  if (/invalid_client|unauthorized_client/.test(msg)) return 'クライアントID かクライアントシークレットが違います。Google Cloud の認証情報と見比べてください';
  if (/Gmail API エラー 403/.test(msg)) return 'Gmail API が有効になっていないか、許可の範囲が gmail.modify になっていません';
  if (/Gmail API エラー 401/.test(msg)) return 'Googleの鍵が無効です。発行し直してください';
  return 'Cloudflare の Worker → Logs でも詳細を見られます';
}

async function run(rawEnv, { dryRun }) {
  // コピー時に混ざりやすい前後の空白・改行を取り除く
  const env = Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  const log = [];
  const say = (s) => { console.log(s); log.push(s); };

  const gmail = await gmailClient(env);
  const labels = dryRun ? null : {
    pending: await gmail.labelId(LABEL_PENDING),
    done: await gmail.labelId(LABEL_DONE),
  };

  // ① 起動済みのメールの結果を確かめて★を付ける
  if (!dryRun) await confirmPending(env, gmail, labels, say);

  // ② 新しい反響通知を探して起動する
  const q = `from:(${ALLOWED_FROM.join(' OR ')}) newer_than:${LOOKBACK}` +
            ` -label:${LABEL_PENDING} -label:${LABEL_DONE} -is:starred`;
  const ids = await gmail.search(q);
  say(`検索: ${q} → ${ids.length}通`);

  const groups = {}; // 貴社コード → メールID の一覧
  const found = [];
  for (const id of ids) {
    const m = await gmail.getMessage(id);
    const hasLink = m.raw.includes(MARKER) || m.text.includes(MARKER);
    const code = extractCode(m.raw, m.snippet, m.text);
    found.push({ date: m.date, subject: m.subject, from: m.from, link: hasLink, code: code || '(読めず)',
                 inquiredAt: extractInquiredAt(m.raw, m.text) || '(読めず)',
                 repo: code ? (COMPANIES[code] || '(COMPANIES に未登録)') : '-' });
    if (!hasLink || !code) continue;
    (groups[code] = groups[code] || []).push(id);
  }

  if (dryRun) return { mode: '確認のみ（GitHubもラベルも触っていない）', found, log };

  for (const [code, msgIds] of Object.entries(groups)) {
    const repo = COMPANIES[code];
    if (!repo) {
      say(`貴社コード ${code} に対応するリポジトリが COMPANIES に未登録です（反響${msgIds.length}件）`);
      continue; // 印は付けない。COMPANIES に足せば次の巡回で拾える
    }
    const ok = await dispatch(env, repo, code, msgIds.length);
    say(`${code}: 反響${msgIds.length}件 → ${repo} 起動 ${ok ? '成功' : '失敗'}`);
    if (!ok) continue; // 起動に失敗したら印は付けない。次の巡回でやり直す
    await gmail.modify(msgIds, [labels.pending], []);
  }

  return { mode: '本番', found, log };
}

/**
 * 「SUUMO起動中」のメールについて GitHub の実行結果を確かめる。
 * メールが届いた後に始まった実行が成功していれば、その反響はダウンロード済み
 * （GitHubは毎回7日分をさかのぼって取るため）。
 */
async function confirmPending(env, gmail, labels, say) {
  const ids = await gmail.search(`label:${LABEL_PENDING} newer_than:7d`);
  for (const id of ids) {
    const m = await gmail.getMessage(id);
    const code = extractCode(m.raw, m.snippet, m.text);
    const repo = COMPANIES[code];
    if (!repo) continue;

    const runs = await latestRuns(env, repo, m.internalDate);
    if (runs === null) continue; // GitHubに問い合わせできなかった。次回また見る

    const success = runs.find(r => r.status === 'completed' && r.conclusion === 'success');
    if (success) {
      await gmail.modify([id], [labels.done, 'STARRED'], [labels.pending]);
      const inquiredAt = extractInquiredAt(m.raw, m.text);
      say(`${code}: ダウンロード成功を確認 → ★を付けました（問合せ日時 ${inquiredAt || '読めず'}） ${success.html_url}`);
      try {
        await gmail.addMemo(m, buildMemo({ code, repo, inquiredAt, runUrl: success.html_url, m }), [labels.done]);
        say(`${code}: スレッドに取込済メモを追加しました`);
      } catch (e) {
        say(`${code}: 取込済メモを追加できませんでした（★とラベルは付いています）: ${e.message}`);
      }
      continue;
    }
    if (runs.some(r => r.status !== 'completed')) continue; // 実行中。待つ

    const failed = runs.find(r => r.status === 'completed');
    const waitedMin = (Date.now() - m.internalDate) / 60000;
    if (failed || waitedMin > GIVEUP_MIN) {
      await gmail.modify([id], [], [labels.pending]); // 次の巡回で起動し直す
      say(`${code}: ${failed ? `GitHubの実行が失敗しました（${failed.conclusion}） ${failed.html_url}` : '実行が見つかりません'}。★は付けず、起動し直します`);
    }
  }
}

/** 取込済メモの本文 */
function buildMemo({ code, repo, inquiredAt, runUrl, m }) {
  const brand = { 'thino-lab/yamaka_only-home': 'オンリーホーム', 'thino-lab/yamaka_naturie': 'ナチュリエ' }[repo] || repo;
  return [
    '【SUUMO 取込済メモ】',
    '',
    `問合せ日時: ${inquiredAt || '(本文から読めませんでした)'}`,
    `ブランド: ${brand}（貴社コード ${code}）`,
    `通知メール受信: ${jst(m.internalDate)}`,
    `取込確認: ${jst(Date.now())}`,
    `GitHub実行: ${runUrl}`,
    '',
    'この反響の顧客情報はダウンロード済みです。',
    '（自動で追加したメモです。誰にも送信していません）',
  ].join('\r\n');
}

function jst(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// ---- GitHub --------------------------------------------------------

async function dispatch(env, repo, code, count) {
  const res = await gh(env, `repos/${repo}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({
      event_type: 'hankyo',
      client_payload: { code, count, at: new Date().toISOString(), from: 'cloudflare' },
    }),
  });
  if (res.status !== 204) {
    // 401=トークン不正、404=リポジトリ名の誤りかトークンの権限不足
    console.error(`GitHub API エラー ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

/** メールが届いた時刻より後に始まった実行を、新しい順に返す。問い合わせ失敗なら null。 */
async function latestRuns(env, repo, sinceMs) {
  const res = await gh(env, `repos/${repo}/actions/runs?per_page=20`);
  if (res.status !== 200) {
    console.error(`${repo}: 実行結果を取得できません (${res.status})。トークンに Actions: Read-only が必要です`);
    return null;
  }
  const json = await res.json();
  return (json.workflow_runs || []).filter(r => new Date(r.created_at).getTime() >= sinceMs);
}

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'suumo-hankyo-watcher',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

// ---- Gmail ---------------------------------------------------------

async function gmailClient(env) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (tokenRes.status !== 200) {
    // invalid_grant = 鍵が無効。パスワード変更・許可の取り消し・「テスト中」の7日切れなど
    throw new Error(`Googleの鍵が使えません (${tokenRes.status}): ${await tokenRes.text()}`);
  }
  const { access_token } = await tokenRes.json();
  const api = (path, init = {}) => fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
  }).then(async r => {
    if (!r.ok) throw new Error(`Gmail API エラー ${r.status} (${path}): ${await r.text()}`);
    return r.text().then(t => (t ? JSON.parse(t) : {})); // batchModify は空の返事を返す
  });

  return {
    async search(q) {
      const j = await api(`messages?maxResults=50&q=${encodeURIComponent(q)}`);
      return (j.messages || []).map(m => m.id);
    },
    async getMessage(id) {
      const j = await api(`messages/${id}?format=raw`);
      return parseMessage(decodeBase64Url(j.raw), j);
    },
    async modify(ids, add, remove) {
      await api('messages/batchModify', {
        method: 'POST',
        body: JSON.stringify({ ids, addLabelIds: add, removeLabelIds: remove }),
      });
    },
    async labelId(name) {
      const j = await api('labels');
      const hit = (j.labels || []).find(l => l.name === name);
      if (hit) return hit.id;
      const made = await api('labels', { method: 'POST', body: JSON.stringify({ name }) });
      return made.id;
    },
    /** 元メールと同じスレッドにメモを1通置く（messages.insert。送信はしない） */
    async addMemo(m, body, labelIds = []) {
      const raw = buildMemoMime(m, body);
      await api('messages?internalDateSource=receivedTime', {
        method: 'POST',
        body: JSON.stringify({ raw, threadId: m.threadId, labelIds: ['INBOX', ...labelIds] }),
      });
    },
  };
}

/** Gmail の raw（1文字1バイト）から必要な情報を取り出す */
function parseMessage(raw, j = {}) {
  const head = raw.split(/\r?\n\r?\n/)[0];
  const header = (name) => {
    const mm = head.match(new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, 'mi'));
    return mm ? mm[1].replace(/\r?\n[ \t]+/g, ' ') : '';
  };
  return {
    raw,
    text: bodyText(raw),
    id: j.id,
    threadId: j.threadId,
    snippet: j.snippet || '',
    internalDate: Number(j.internalDate),
    date: new Date(Number(j.internalDate)).toISOString(),
    subject: header('Subject'),
    from: header('From'),
    messageId: header('Message-ID'),
    references: header('References'),
  };
}

/** メモ用のメール（MIME）を作り、base64url で返す */
function buildMemoMime(m, body) {
  const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const refs = [m.references, m.messageId].filter(Boolean).join(' ').trim();
  const lines = [
    `From: =?UTF-8?B?${b64('SUUMO取込メモ')}?= <${MEMO_FROM}>`,
    `To: ${MEMO_FROM}`,
    `Subject: ${m.subject || 'SUUMO 反響'}`, // 件名は元のまま（同じスレッドにまとめるため）
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    ...(m.messageId ? [`In-Reply-To: ${m.messageId}`] : []),
    ...(refs ? [`References: ${refs}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(body).replace(/.{76}/g, '$&\r\n'),
  ];
  return btoa(lines.join('\r\n')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(s) {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

// ---- 本文の読み取り --------------------------------------------------

/**
 * 本文を日本語の文字列に直して返す（読めない部分は飛ばす）。
 * Googleグループ経由のメールは base64 や quoted-printable に包み直されることがあるので、
 * MIME の各パートをほどいてから文字コード（ISO-2022-JP / UTF-8 / Shift_JIS）を戻す。
 */
function bodyText(raw) {
  const out = [];
  const walk = (part, depth) => {
    if (depth > 5) return;
    const sep = part.search(/\r?\n\r?\n/);
    if (sep < 0) return;
    const head = part.slice(0, sep).replace(/\r?\n[ \t]+/g, ' ');
    let body = part.slice(sep).replace(/^\r?\n\r?\n/, '');
    const ctype = (head.match(/^Content-Type:\s*([^;\r\n]+)/mi) || [])[1] || 'text/plain';
    const boundary = (head.match(/boundary="?([^";\r\n]+)"?/i) || [])[1];
    if (/^multipart\//i.test(ctype) && boundary) {
      for (const sub of body.split('--' + boundary).slice(1)) {
        if (sub.startsWith('--')) break;
        walk(sub.replace(/^\r?\n/, ''), depth + 1);
      }
      return;
    }
    if (!/^text\//i.test(ctype)) return;
    const cte = ((head.match(/^Content-Transfer-Encoding:\s*(\S+)/mi) || [])[1] || '').toLowerCase();
    if (cte === 'base64') { try { body = atob(body.replace(/[^A-Za-z0-9+/=]/g, '')); } catch (e) {} }
    else if (cte === 'quoted-printable') {
      body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    const charset = ((head.match(/charset="?([^";\s]+)"?/i) || [])[1] || 'utf-8').toLowerCase();
    let t = decodeBytes(body, charset);
    if (/^text\/html/i.test(ctype)) t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    out.push(t);
  };
  walk(raw, 0);
  return out.join('\n');
}

/** 1文字1バイトの文字列を、指定の文字コードで文字に戻す */
function decodeBytes(bin, charset) {
  if (/2022/.test(charset) || /\x1b\$[B@]/.test(bin)) return decodeJis(bin);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0) & 0xff);
  try { return new TextDecoder(charset).decode(bytes); } catch (e) {}
  try { return new TextDecoder('utf-8').decode(bytes); } catch (e) {}
  return bin;
}

/**
 * ISO-2022-JP を文字に戻す。使える環境なら TextDecoder、無ければ
 * 日時・貴社コードを読むのに必要な文字（数字・年月日時分秒など）だけ自前で戻す。
 */
function decodeJis(bin) {
  try {
    return new TextDecoder('iso-2022-jp').decode(Uint8Array.from(bin, c => c.charCodeAt(0) & 0xff));
  } catch (e) {}
  const map = {
    'G/': '年', '7n': '月', 'F|': '日', ';~': '時', 'J,': '分', 'IC': '秒',
    'Ld': '問', '9g': '合', '$;': 'せ', '5.': '貴', '<R': '社', '%3': 'コ', '!<': 'ー', '%I': 'ド',
    '!!': '　', "!'": '：', '!?': '／', '!\\': '－', '!J': '（', '!K': '）',
  };
  let out = '', two = false;
  for (let i = 0; i < bin.length; i++) {
    if (bin[i] === '\x1b') {
      const seq = bin.slice(i, i + 3);
      if (seq === '\x1b$B' || seq === '\x1b$@') { two = true; i += 2; continue; }
      if (seq === '\x1b(B' || seq === '\x1b(J') { two = false; i += 2; continue; }
    }
    if (two && bin[i] !== '\r' && bin[i] !== '\n') {
      const p = bin.slice(i, i + 2); i++;
      out += (p[0] === '#' && /[0-9]/.test(p[1])) ? p[1] : (map[p] || '〓');
    } else {
      out += bin[i];
    }
  }
  return out;
}

const zen = (s) => String(s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

/**
 * 本文から貴社コードを取り出す。
 * SUUMOの通知は ISO-2022-JP（JIS）で届くので、まずバイト列のまま探す。
 * 「貴社コード：」は JIS では "5.<R%3!<%I!'" というバイト列になる。
 * 見つからなければ、文字に戻した本文（text）や Gmail の抜粋（snippet）から探す。
 * 全角数字（１３０９６７）で書かれていても半角に直す。
 */
function extractCode(raw, snippet, text = '') {
  // ① JIS: 貴社コード： の直後に、半角数字（ESC ( B で切り替え）か全角数字（#0〜#9）
  let m = raw.match(/5\.<R%3!<%I!'(?:\x1b\([BJ])?[ \t]*([0-9]{4,8})/);
  if (m) return m[1];
  m = raw.match(/5\.<R%3!<%I!'((?:#[0-9]){4,8})/);
  if (m) return m[1].replace(/#/g, '');

  // ② 文字に戻した本文や snippet
  const texts = [text, snippet];
  try { texts.push(new TextDecoder('utf-8').decode(Uint8Array.from(raw, c => c.charCodeAt(0) & 0xff))); } catch (e) {}
  for (const t of texts) {
    const u = String(t || '').match(/貴社コード[\s　]*[：:][\s　]*([0-9０-９]{4,8})/);
    if (u) return zen(u[1]);
  }
  return null;
}

/**
 * 本文から「問合せ日時」を取り出し、"2026/10/01 14:24:27" の形で返す。読めなければ null。
 * 例: 問合せ日時　２０２６年１０月　1日１４時２４分２７秒
 *     （全角・半角数字の混在、間の空白にも対応）
 */
function extractInquiredAt(raw, text = '') {
  const texts = [text];
  if (!text) texts.push(decodeJis(raw));
  const sp = '[\\s　]*';
  const re = new RegExp(
    `問(?:い)?合(?:わ)?せ日時${sp}[：:]?${sp}` +
    `([0-9０-９]{4})${sp}年${sp}([0-9０-９]{1,2})${sp}月${sp}([0-9０-９]{1,2})${sp}日${sp}` +
    `([0-9０-９]{1,2})${sp}[時:：]${sp}([0-9０-９]{1,2})${sp}[分:：]${sp}(?:([0-9０-９]{1,2})${sp}秒?)?`);
  const re2 = new RegExp( // 2026/10/01 14:24:27 形式
    `問(?:い)?合(?:わ)?せ日時${sp}[：:]?${sp}` +
    `([0-9０-９]{4})[/／\\-－]([0-9０-９]{1,2})[/／\\-－]([0-9０-９]{1,2})${sp}` +
    `([0-9０-９]{1,2})[:：]([0-9０-９]{1,2})(?:[:：]([0-9０-９]{1,2}))?`);
  for (const t of texts) {
    const m = String(t || '').match(re) || String(t || '').match(re2);
    if (!m) continue;
    const n = m.slice(1).map(v => (v === undefined ? '00' : zen(v).padStart(2, '0')));
    return `${n[0]}/${n[1]}/${n[2]} ${n[3]}:${n[4]}:${n[5]}`;
  }
  return null;
}

// テストから呼べるようにする
export { extractCode, extractInquiredAt, bodyText, parseMessage, buildMemoMime, buildMemo, decodeJis, run };
