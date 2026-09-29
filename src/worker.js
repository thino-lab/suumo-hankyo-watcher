/**
 * SUUMOの反響通知メールを見張り、届いていたら GitHub Actions を起動する（Cloudflare Worker）。
 *
 * 【流れ】
 *  1. 5分おき（Cron Trigger）に system.ss@pure-growth.net の Gmail を探す
 *  2. 反響通知（SUUMOから届き、本文にダウンロードリンクがあるもの）を見つけたら、
 *     本文の「貴社コード」でブランドを判定し、そのリポジトリを起動する
 *     → メールに「SUUMO起動中」ラベルを付ける（同じメールで二度起動しない）
 *  3. 次の巡回以降で GitHub の実行結果を確かめる
 *     成功 → ★ と「SUUMO取込済」ラベルを付け、「SUUMO起動中」を外す
 *     失敗 → 「SUUMO起動中」を外すだけ。次の巡回でもう一度起動する
 *
 * 【★のルール】
 *  ★は「顧客情報のダウンロードまで済んだ」印。GitHubを起動しただけでは付けない。
 *
 * 【必要なシークレット】（Cloudflare の Settings → Variables and Secrets）
 *  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN … Gmail を読む・★を付ける鍵
 *  GITHUB_TOKEN  … Contents: Read and write と Actions: Read-only が付いたトークン
 *  TEST_KEY      … 動作確認用URLの合言葉（好きな長い文字列）
 */

// ---- 設定 ----------------------------------------------------------

// 貴社コード → 起動するリポジトリ。ブランドが増えたらここに1行足す。
// 貴社コードは反響通知メール本文の「貴社コード：」の番号（= HONEYのダウンロードファイル名の先頭6桁）。
const COMPANIES = {
  '501482': 'thino-lab/yamaka_only-home',   // 株式会社ヤマカ木材（オンリーホーム）
  '130967': 'thino-lab/yamaka_naturie',     // 株式会社ヤマカ木材（ナチュリエ）
};

// SUUMOの送信元。支援先のGmailで自動転送されたものも、差出人はこのまま届く。
const ALLOWED_FROM = ['hankyo@housingnavi.jp'];

const MARKER = '/house/hj/operation/download';  // 本文にこのリンクがあるものだけ対象
const LABEL_DONE = 'SUUMO取込済';                // ダウンロードまで済んだ目印（★と一緒に付ける）
const LABEL_PENDING = 'SUUMO起動中';             // GitHubを起動し、結果を待っている目印
const LOOKBACK = '2d';                          // さかのぼって探す範囲
const GIVEUP_MIN = 60;                          // 起動からこの分数たっても実行が見つからなければ起動し直す

// --------------------------------------------------------------------


export default {
  // Cron Trigger（5分おき）から呼ばれる本体
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, { dryRun: false }).catch(e => console.error(`止まりました: ${e.message}`)));
  },

  // 動作確認用。https://<worker>.workers.dev/check?key=<TEST_KEY>
  //   /check         … 見つかったメールを一覧で返すだけ。GitHubもラベルも触らない（安全）
  //   /check?run=1   … 本番と同じ処理を今すぐ1回実行する
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

async function run(env, { dryRun }) {
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

  const groups = {};   // 貴社コード → メールID の一覧
  const found = [];
  for (const id of ids) {
    const m = await gmail.getMessage(id);
    const hasLink = m.raw.includes(MARKER);
    const code = extractCode(m.raw, m.snippet);
    found.push({ date: m.date, subject: m.subject, link: hasLink, code: code || '(読めず)',
                 repo: code ? (COMPANIES[code] || '(COMPANIES に未登録)') : '-' });
    if (!hasLink || !code) continue;
    (groups[code] = groups[code] || []).push(id);
  }

  if (dryRun) return { mode: '確認のみ（GitHubもラベルも触っていない）', found, log };

  for (const [code, msgIds] of Object.entries(groups)) {
    const repo = COMPANIES[code];
    if (!repo) {
      say(`貴社コード ${code} に対応するリポジトリが COMPANIES に未登録です（反響${msgIds.length}件）`);
      continue;   // 印は付けない。COMPANIES に足せば次の巡回で拾える
    }
    const ok = await dispatch(env, repo, code, msgIds.length);
    say(`${code}: 反響${msgIds.length}件 → ${repo} 起動 ${ok ? '成功' : '失敗'}`);
    if (!ok) continue;   // 起動に失敗したら印は付けない。次の巡回でやり直す
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
    const m = await gmail.getMessage(id, true);
    const code = extractCode(m.raw, m.snippet);
    const repo = COMPANIES[code];
    if (!repo) continue;

    const runs = await latestRuns(env, repo, m.internalDate);
    if (runs === null) continue;                       // GitHubに問い合わせできなかった。次回また見る

    const success = runs.find(r => r.status === 'completed' && r.conclusion === 'success');
    if (success) {
      await gmail.modify([id], [labels.done, 'STARRED'], [labels.pending]);
      say(`${code}: ダウンロード成功を確認 → ★を付けました ${success.html_url}`);
      continue;
    }
    if (runs.some(r => r.status !== 'completed')) continue;   // 実行中。待つ

    const failed = runs.find(r => r.status === 'completed');
    const waitedMin = (Date.now() - m.internalDate) / 60000;
    if (failed || waitedMin > GIVEUP_MIN) {
      await gmail.modify([id], [], [labels.pending]);  // 次の巡回で起動し直す
      say(`${code}: ${failed ? `GitHubの実行が失敗しました（${failed.conclusion}） ${failed.html_url}` : '実行が見つかりません'}。★は付けず、起動し直します`);
    }
  }
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
    return r.json();
  });

  return {
    async search(q) {
      const j = await api(`messages?maxResults=50&q=${encodeURIComponent(q)}`);
      return (j.messages || []).map(m => m.id);
    },
    async getMessage(id) {
      const j = await api(`messages/${id}?format=raw`);
      const raw = decodeBase64Url(j.raw);                       // バイト列をそのまま1文字1バイトで持つ
      const header = (name) => (raw.match(new RegExp(`^${name}:\\s*(.*)$`, 'mi')) || [])[1] || '';
      return {
        raw,
        snippet: j.snippet || '',
        internalDate: Number(j.internalDate),
        date: new Date(Number(j.internalDate)).toISOString(),
        subject: header('Subject'),
      };
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
  };
}

function decodeBase64Url(s) {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}


/**
 * 本文から貴社コードを取り出す。
 * SUUMOの通知は ISO-2022-JP（JIS）で届くので、日本語を文字に戻さずバイト列のまま探す。
 *   「貴社コード：」は JIS では "5.<R%3!<%I!'" というバイト列になる。
 * 念のため、UTF-8で届いた場合や Gmail の抜粋（snippet）からも探す。
 * 全角数字（１３０９６７）で書かれていても半角に直す。
 */
function extractCode(raw, snippet) {
  const zen = (s) => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

  // ① JIS: 貴社コード： の直後に、半角数字（ESC ( B で切り替え）か全角数字（#0〜#9）
  let m = raw.match(/5\.<R%3!<%I!'(?:\x1b\([BJ])?[ \t]*([0-9]{4,8})/);
  if (m) return m[1];
  m = raw.match(/5\.<R%3!<%I!'((?:#[0-9]){4,8})/);
  if (m) return m[1].replace(/#/g, '');

  // ② UTF-8 や snippet
  const texts = [snippet];
  try { texts.push(new TextDecoder('utf-8').decode(Uint8Array.from(raw, c => c.charCodeAt(0)))); } catch (e) {}
  for (const t of texts) {
    const u = String(t).match(/貴社コード[：:][\s　]*([0-9０-９]{4,8})/);
    if (u) return zen(u[1]);
  }
  return null;
}

// テストから呼べるようにする
export { extractCode, run };
