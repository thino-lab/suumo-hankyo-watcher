// 疑似の Gmail / GitHub で流れを試す。実行: node test/worker.test.mjs
import fs from 'fs';
import { extractCode, run } from '../src/worker.js';
const eml = fs.readFileSync(new URL('./sample-notice.eml', import.meta.url));
const raw = eml.toString('latin1');
console.log('見本メールの貴社コード:', extractCode(raw, ''), '/ リンクあり:', raw.includes('/house/hj/operation/download'));
console.log('UTF-8本文:', extractCode('', ''), extractCode(Buffer.from('（貴社コード：５０１４８２）','utf8').toString('latin1'), ''));
console.log('snippet:', extractCode('', 'ヤマカ木材 御中 （貴社コード：130967） 問合せ'));

// ---- 全体の流れを疑似Gmail/GitHubで試す ----
const b64 = (buf) => buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_');
const now = Date.now();
const msgs = { m1: { raw: eml, date: now - 10*60000, labels: new Set() } };
let runs = [];
const calls = [];
globalThis.fetch = async (url, init={}) => {
  const u = new URL(url); const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  const ok = (j, s=200) => new Response(JSON.stringify(j), { status: s });
  if (u.host === 'oauth2.googleapis.com') return ok({ access_token: 'x' });
  if (u.host === 'gmail.googleapis.com') {
    const p = u.pathname.replace('/gmail/v1/users/me/','');
    if (p === 'labels' && init.method === 'POST') return ok({ id: 'L_'+body.name });
    if (p === 'labels') return ok({ labels: [] });
    if (p === 'messages') {
      const q = u.searchParams.get('q');
      const ids = Object.keys(msgs).filter(id => {
        const L = msgs[id].labels;
        if (q.startsWith('label:')) return L.has('L_SUUMO起動中');
        return !L.has('L_SUUMO起動中') && !L.has('L_SUUMO取込済') && !L.has('STARRED');
      });
      return ok({ messages: ids.map(id => ({ id })) });
    }
    if (p === 'messages/batchModify') { calls.push(['modify', body]); body.ids.forEach(id => { body.addLabelIds.forEach(l => msgs[id].labels.add(l)); body.removeLabelIds.forEach(l => msgs[id].labels.delete(l)); }); return new Response('', { status: 200 }); }   // 本物の batchModify は空の返事
    const id = p.split('/')[1]; return ok({ raw: b64(msgs[id].raw), snippet: '', internalDate: String(msgs[id].date) });
  }
  if (u.host === 'api.github.com') {
    if (u.pathname.endsWith('/dispatches')) { calls.push(['dispatch', u.pathname]); return new Response(null, { status: 204 }); }
    return ok({ workflow_runs: runs });
  }
  throw new Error('unexpected ' + url);
};
const env = { GOOGLE_CLIENT_ID:'a', GOOGLE_CLIENT_SECRET:'b', GOOGLE_REFRESH_TOKEN:'c', GITHUB_TOKEN:'d' };
console.log = ((orig) => (...a) => orig('   ', ...a))(console.log);

let r = await run(env, { dryRun: true });
process.stdout.write('\n[確認のみ] ' + JSON.stringify(r.found) + ' / 呼び出し ' + calls.length + '件\n');
await run(env, { dryRun: false });
process.stdout.write('[1回目] 起動: ' + JSON.stringify(calls.filter(c=>c[0]==='dispatch')) + ' ラベル: ' + [...msgs.m1.labels] + '\n');
runs = [{ created_at: new Date().toISOString(), status: 'in_progress', html_url: 'u' }];
await run(env, { dryRun: false });
process.stdout.write('[2回目・実行中] ラベル: ' + [...msgs.m1.labels] + ' 起動回数: ' + calls.filter(c=>c[0]==='dispatch').length + '\n');
runs[0].status = 'completed'; runs[0].conclusion = 'success';
await run(env, { dryRun: false });
process.stdout.write('[3回目・成功] ラベル: ' + [...msgs.m1.labels] + ' 起動回数: ' + calls.filter(c=>c[0]==='dispatch').length + '\n');
// 失敗ケース
msgs.m1.labels = new Set(['L_SUUMO起動中']); runs = [{ created_at: new Date().toISOString(), status: 'completed', conclusion: 'failure', html_url: 'u' }];
await run(env, { dryRun: false });
process.stdout.write('[失敗] ラベル: ' + [...msgs.m1.labels] + ' 起動回数: ' + calls.filter(c=>c[0]==='dispatch').length + '（失敗後に起動し直した）\n');
