// Public setup instructions only. No household data, server-side token creation,
// third-party scripts, analytics, or credential-containing DOM attributes.
export function setupPage(nonce: string): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>建立家庭專屬連結</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:#f5f7fb;color:#172033;font:17px/1.6 system-ui,sans-serif}.card{max-width:650px;margin:auto;padding:26px;background:white;border:1px solid #dce4ef;border-radius:22px}h1{font-size:26px;line-height:1.3}h2{font-size:19px;margin-top:26px}button,a.action{display:block;width:100%;padding:14px;margin:10px 0;border:0;border-radius:12px;background:#2f69bb;color:white;font:700 16px system-ui;text-align:center;text-decoration:none;cursor:pointer}button:disabled{background:#c1cbda;cursor:default}.note{padding:14px;background:#fff5df;border-radius:12px}.status{padding:14px;background:#edf4ff;border-radius:12px;min-height:56px}code{font-size:15px;overflow-wrap:anywhere}.secondary{background:#52657f}small{color:#5d6a7d}p{margin:10px 0}</style></head>
<body><main class="card"><h1>建立家庭專屬連結</h1>
<p>這個頁面由家人管理者設定一次。媽媽收到連結後，直接點開即可，不用輸入密碼或登入。</p>
<p class="note">私人連結就是鑰匙：任何拿到連結的人都能讀寫家庭帳單。請只由你本人分享給授權家人，不要傳到公開群組或貼給助理。</p>
<h2>1. 在這個瀏覽器建立</h2><p>按下按鈕後，這個瀏覽器會本機產生隨機鑰匙；伺服器不會替你建立或回傳鑰匙。</p>
<button id="generate">建立私人連結</button><small id="generatedNote">尚未建立。鑰匙只暫存在目前分頁，關閉前請自行保存私人連結。</small>
<h2>2. 由你設定 Cloudflare</h2><p>複製驗證值，在新 Worker 的「Settings → Variables and Secrets → Add」選擇 <b>Secret</b>，名稱填 <code>YILAN_ACCESS_TOKEN_SHA256</code>，值貼上後儲存並部署。請勿改成一般文字變數。</p>
<button id="copyVerifier" disabled>複製驗證值</button>
<a class="action secondary" id="dashboard" href="https://dash.cloudflare.com/b979a664c9799de33d5e367e776dc0b9/workers/services/view/yilan-sync-v3/production/settings" target="_blank" rel="noopener noreferrer">開啟新 Worker 設定</a>
<button id="verify" disabled>設定好了，檢查連線</button>
<p id="status" class="status" role="status" aria-live="polite">尚未建立私人連結</p>
<h2>3. 由你把連結傳給媽媽</h2><p>連線檢查成功，而且新 App 已完成上線後，再傳給媽媽。若手機舊資料不同，App 會保留兩份等家人核對，避免覆蓋。</p>
<button id="copyLink" disabled>複製私人連結</button><button id="shareLink" disabled>分享私人連結</button>
<p><small>鑰匙遺失或連結外流：重新建立並更換 Cloudflare 驗證值，舊連結會立刻失效，再由你重新分享。不要把原始鑰匙或連結貼進 Cloudflare。</small></p>
<button id="forget" class="secondary" disabled>完成後清除此分頁的鑰匙</button></main>
<script nonce="${nonce}">
(() => {
  'use strict';
  const KEY='yilanPrivateLinkSetup:v1';
  const APP='https://bensonchen1204.github.io/-electricity-bill/';
  const el=id=>document.getElementById(id);
  let token='',verifier='',verified=false,busy=true;
  const status=text=>{el('status').textContent=text;};
  function update(){
    el('generate').disabled=busy;
    el('generate').textContent=token?'重新建立（更換後舊連結將失效）':'建立私人連結';
    el('copyVerifier').disabled=!token||busy;el('verify').disabled=!token||busy;
    el('verify').textContent=verified?'連線驗證成功 ✓':busy?'正在處理…':'設定好了，檢查連線';
    el('copyLink').disabled=!verified||busy;el('shareLink').disabled=!verified||busy;
    el('forget').disabled=!token||busy;
    el('generatedNote').textContent=token?'這個分頁已保存一把本機鑰匙；頁面不會顯示完整鑰匙。':'尚未建立。鑰匙只暫存在目前分頁，關閉前請自行保存私人連結。';
  }
  async function hash(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
  const link=()=>APP+'#yilan-access='+token;
  async function copy(text,done){try{await navigator.clipboard.writeText(text);status(done);}catch(_){status('此瀏覽器無法使用複製功能，請換用支援剪貼簿的瀏覽器；不要把鑰匙貼到聊天求助。');}}
  el('generate').onclick=async()=>{
    if(busy)return;
    if(token&&!confirm('重新建立後，還需要更換 Cloudflare 驗證值。更換後原先的家庭連結都會失效。確定建立新的鑰匙？'))return;
    busy=true;update();
    try{
      const bytes=crypto.getRandomValues(new Uint8Array(32));
      const next=btoa(String.fromCharCode(...bytes)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
      const nextHash=await hash(next);
      sessionStorage.setItem(KEY,next);
      if(sessionStorage.getItem(KEY)!==next)throw new Error('storage');
      token=next;verifier=nextHash;verified=false;status('已在這個分頁建立。請複製驗證值並自行設定 Cloudflare。');
    }catch(_){status('無法安全保存鑰匙，尚未完成建立。請使用正常瀏覽模式且不要清除目前資料。');}
    finally{busy=false;update();}
  };
  el('copyVerifier').onclick=()=>{if(token&&!busy)copy(verifier,'驗證值已複製。請貼入 Cloudflare 的 Secret 欄位並儲存部署。');};
  el('verify').onclick=async()=>{
    if(!token||busy)return;busy=true;verified=false;update();status('正在驗證新的同步連線…');
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch('/v1/state',{headers:{Authorization:'Bearer '+token},mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
      if(response.status===503){status('服務尚未完成驗證值設定，或暫時無法連線。請確認 Secret 名稱與值後再試。');return;}
      if(response.status===401){status('驗證值與這個分頁的鑰匙不符。請重新複製驗證值到 Cloudflare，切勿貼私人連結。');return;}
      if(response.status===429){status('嘗試過於頻繁，請稍後再試。');return;}
      if(!response.ok){status('驗證未成功，請保留此分頁並告知服務管理者錯誤代碼 '+response.status+'（不要傳鑰匙）。');return;}
      const data=await response.json();
      if(!data.exists||!data.payload||!Array.isArray(data.payload.rooms)||data.payload.rooms.length!==6){status('驗證已通過，但家庭基準資料尚未準備好，請先不要分享。');return;}
      verified=true;status('連線驗證成功，家庭資料已就緒。請告知助理「連線檢查成功」，等新 App 上線完成後，再由你分享私人連結給媽媽。');
    }catch(_){status('目前無法完成連線檢查。鑰匙仍保留於這個分頁，請稍後重試。');}
    finally{clearTimeout(timeout);busy=false;update();el('status').scrollIntoView?.({behavior:'smooth',block:'center'});}
  };
  el('copyLink').onclick=()=>{if(verified&&!busy)copy(link(),'私人連結已複製。請只由你本人傳給媽媽或授權家人。');};
  el('shareLink').onclick=async()=>{if(!verified||busy)return;if(!navigator.share){await copy(link(),'私人連結已複製，請只分享給授權家人。');return;}try{await navigator.share({title:'家庭帳單',text:'請保留這條私人連結，不要轉傳。',url:link()});status('已開啟分享，請確認你選擇的是授權家人。');}catch(_){status('分享已取消。你仍可自行複製私人連結。');}};
  el('forget').onclick=()=>{if(!token||busy)return;if(!confirm('請先自行保存或分享私人連結。清除此分頁後無法從伺服器取回鑰匙。確定清除？'))return;try{sessionStorage.removeItem(KEY);token='';verifier='';verified=false;status('此分頁的鑰匙已清除，已分享的連結仍有效。');update();}catch(_){status('無法清除此分頁暫存，請在保存連結後關閉分頁。');}};
  (async()=>{try{const saved=sessionStorage.getItem(KEY);if(saved&&/^[A-Za-z0-9_-]{43}$/.test(saved)){token=saved;verifier=await hash(token);status('已恢復此分頁的鑰匙，請完成 Cloudflare 設定並重新檢查連線。');}}catch(_){status('無法讀取本機暫存，請勿在設定完成前關閉分頁。');}finally{busy=false;update();}})();update();
})();
</script></body></html>`;
}
