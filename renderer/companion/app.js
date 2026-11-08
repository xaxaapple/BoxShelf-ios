// Boxshelf phone companion (served by main/companion.js to phones on the home Wi-Fi).
// Library and game pages, Play on the TV, the game's manual, a remote (d-pad, face buttons) and a keyboard for the TV's
// search boxes. Everything is plain DOM: it has to feel instant on a mid-range phone.
(function(){
"use strict";
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let lib=null,shelfId=null,query="",glyph={style:"xbox",swap:false},running=null,curGame=null,statusT=0,toastT=0,tab="Library";

/* ---------- talking to Boxshelf ---------- */
async function api(path,body){
  const o=body===undefined?{credentials:"same-origin",cache:"no-store"}:{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)};
  let r;try{r=await fetch(path,o)}catch(e){throw Object.assign(new Error("Can't reach Boxshelf. Is the PC on and this phone on the same Wi-Fi?"),{net:true})}
  let j=null;try{j=await r.json()}catch{}
  if(r.status===401){showPair();throw Object.assign(new Error("Pair this phone first."),{status:401})}
  if(!r.ok){const e=new Error(j&&j.error||`Error ${r.status}`);e.status=r.status;e.data=j;throw e}
  return j}
function toast(t){const el=$("toast");el.textContent=t;el.classList.add("on");clearTimeout(toastT);toastT=setTimeout(()=>el.classList.remove("on"),2600)}
const buzz=ms=>{try{navigator.vibrate&&navigator.vibrate(ms)}catch{}};

/* ---------- pairing ---------- */
function showPair(){$("main").hidden=true;$("game").hidden=true;$("manual").hidden=true;$("pair").hidden=false;stopStatus();
  const m=/[#&]pin=(\d{6})/.exec(location.hash);if(m){$("pin").value=m[1];setTimeout(()=>$("pname").focus(),50)}else setTimeout(()=>$("pin").focus(),50)}
$("pin").addEventListener("input",e=>{e.target.value=e.target.value.replace(/\D/g,"").slice(0,6)});
$("pairForm").addEventListener("submit",async e=>{e.preventDefault();const pin=$("pin").value.trim(),msg=$("pairMsg");msg.className="msg";
  if(!/^\d{6}$/.test(pin)){msg.textContent="The PIN has 6 digits.";return}
  $("pairBtn").disabled=true;msg.textContent="";
  try{const r=await api("/api/pair",{pin,name:$("pname").value.trim()});msg.className="msg ok";msg.textContent=`Paired as ${r.name}`;history.replaceState(null,"",location.pathname);buzz(20);setTimeout(start,350)}
  catch(err){msg.textContent=err.message;if(err.status===403)$("pin").select()}
  finally{$("pairBtn").disabled=false}});

/* ---------- start ---------- */
async function start(){
  try{await api("/api/me")}catch(e){if(e.status===401)return;$("pair").hidden=true;$("main").hidden=false;$("libEmpty").hidden=false;$("libEmpty").textContent=e.message;return}
  if(/pin=/.test(location.hash))history.replaceState(null,"",location.pathname); // already paired: the PIN in the address isn't needed
  $("pair").hidden=true;$("main").hidden=false;loadLibrary();startStatus()}

/* ---------- library ---------- */
async function loadLibrary(){
  try{lib=await api("/api/library")}catch(e){if(e.status!==401){$("libEmpty").hidden=false;$("libEmpty").textContent=e.message}return}
  setGlyphs(lib.glyphs);
  if(!lib.shelves.some(s=>s.id===shelfId))shelfId=lib.shelves[0]?lib.shelves[0].id:null;
  renderShelves();renderGrid()}
function renderShelves(){const nav=$("shelves");nav.innerHTML="";
  (lib?lib.shelves:[]).forEach(s=>{const b=document.createElement("button");b.className="chip"+(s.id===shelfId&&!query?" on":"");b.textContent=`${s.name} · ${s.games.length}`;b.type="button";
    b.onclick=()=>{shelfId=s.id;if(query){query="";$("q").value=""}renderShelves();renderGrid();scrollTo({top:0})};nav.append(b)});
  const on=nav.querySelector(".on");if(on)on.scrollIntoView({inline:"nearest",block:"nearest"})}
const norm=s=>String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g," ").trim();
// pictures load as they come near the screen (one watcher for the grid, one for the manual's pages)
const IO={};
function lazy(img,k,root){let o=IO[k];if(!o)o=IO[k]=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){const i=e.target;o.unobserve(i);i.src=i.dataset.src}}),{root:root||null,rootMargin:"800px 0px"});o.observe(img)}
const unlazy=k=>{if(IO[k]){IO[k].disconnect();IO[k]=null}};
function renderGrid(){const grid=$("grid"),empty=$("libEmpty");grid.innerHTML="";unlazy("g");
  if(!lib||!lib.shelves.length){empty.hidden=false;empty.textContent="No games yet. Set up your consoles in Boxshelf's Settings on the TV.";return}
  let list;const q=norm(query);
  if(q){const words=q.split(" ");list=[];lib.shelves.forEach(s=>s.games.forEach(g=>{const t=g._n||(g._n=norm(g.t));if(words.every(w=>t.includes(w)))list.push([s,g])}))}
  else{const s=lib.shelves.find(x=>x.id===shelfId)||lib.shelves[0];list=s.games.map(g=>[s,g])}
  empty.hidden=!!list.length;if(!list.length)empty.textContent=`Nothing matches "${query}".`;
  const frag=document.createDocumentFragment();
  for(const [s,g] of list.slice(0,600)){const b=document.createElement("button");b.type="button";b.className="tile"+(s.kind==="apps"||s.kind==="steam"&&!g.c?" wide":"");
    b.innerHTML=`<div class="art"><span class="ph">${esc(g.t)}</span></div><span class="nm">${esc(g.t)}</span>${q?`<span class="sub">${esc(s.name)}</span>`:""}`;
    if(g.c){const i=new Image();i.alt="";i.decoding="async";i.dataset.src=`/img/${g.c}?h=360`;i.onload=()=>{i.classList.add("in");const ph=i.previousSibling;if(ph)ph.remove()};i.onerror=()=>i.remove();b.firstChild.append(i);lazy(i,"g")}
    b.onclick=()=>openGame(g.id);frag.append(b)}
  grid.append(frag);if(list.length>600){const p=document.createElement("p");p.className="empty";p.textContent=`Showing 600 of ${list.length}. Search to find the rest.`;grid.append(p)}}
let qT=0;$("q").addEventListener("input",e=>{clearTimeout(qT);qT=setTimeout(()=>{query=e.target.value;renderShelves();renderGrid()},120)});
$("q").addEventListener("keydown",e=>{if(e.key==="Enter")e.target.blur()});

/* ---------- a game ---------- */
const fmtSize=b=>!b?"":b>=1073741824?(b/1073741824).toFixed(1)+" GB":Math.round(b/1048576)+" MB";
let gameSeq=0;
async function openGame(id){const seq=++gameSeq;let g;try{g=await api("/api/game?id="+encodeURIComponent(id))}catch(e){if(e.status!==401)toast(e.message);return}
  if(seq!==gameSeq)return;curGame=g;
  $("gTitle").textContent=g.t;$("gShelf").textContent=g.shelf||"";
  const hero=g.hero||g.cover;$("gHero").hidden=!hero;$("gHero").classList.toggle("soft",!g.hero); /* no background art: the cover, softened into colour (as the shelf's blur background) */if(hero)$("gHero").src=`/img/${hero}?h=720`;else $("gHero").removeAttribute("src");
  $("gCover").hidden=!g.cover;if(g.cover)$("gCover").src=`/img/${g.cover}?h=480`;else $("gCover").removeAttribute("src");
  const I=g.info||{};$("gMeta").textContent=[I.year||(I.release?String(I.release).slice(0,4):""),I.dev,g.region].filter(Boolean).join(" · ");
  $("gDesc").textContent=I.overview||"";
  const facts=[["Publisher",I.pub],["Genre",Array.isArray(I.genres)?I.genres.join(", "):I.genres],["Players",I.players],["Rating",I.rating?I.rating+" / 5":""],["Age rating",I.esrb],["Size",fmtSize(g.size)]].filter(f=>f[1]);
  $("gFacts").innerHTML=facts.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  const n=(g.manual||[]).length;$("gManual").hidden=!n;$("gManual").textContent=`Read the manual · ${n} page${n===1?"":"s"}`;$("gPdf").hidden=!g.manualPdf;
  $("gPlay").querySelector("span").textContent=g.kind==="app"?"Open on TV":"Play on TV";
  $("gAch").hidden=true;$("gAch").innerHTML="";
  if(g.ra)api("/api/ach?id="+encodeURIComponent(g.id)).then(r=>{if(seq!==gameSeq||!r||!r.ach)return;const a=r.ach,p=Math.round(100*a.earned/Math.max(1,a.total));
    $("gAch").innerHTML=`<span>🏆 ${a.earned} / ${a.total}</span><span class="bar"><i></i></span><span class="muted small">${a.pointsEarned||0} / ${a.points||0} pts</span>`;$("gAch").querySelector(".bar i").style.width=p+"%";$("gAch").hidden=false}).catch(()=>{});
  if($("game").hidden){$("game").hidden=false;history.pushState({v:"game"},"")}
  $("game").scrollTop=0}
function closeGame(){$("game").hidden=true;curGame=null;gameSeq++}
$("gClose").onclick=()=>history.back();
$("gPlay").onclick=()=>play(false);
let playing=false;
async function play(quit){if(!curGame||playing)return;playing=true;const g=curGame;$("gPlay").disabled=true;
  try{await api("/api/play",{id:g.id,quit});buzz(30);toast(quit?`Closing the game, then starting ${g.t}…`:`Starting ${g.t} on the TV…`);setTimeout(pollStatus,1500)}
  catch(e){if(e.status===409&&e.data&&e.data.running){if(e.data.stuck){toast("The running game didn't close. Try Quit again.");return}ask(e.data.running,g)}else if(e.status!==401)toast(e.message)}
  finally{playing=false;$("gPlay").disabled=false}}
function ask(r,g){$("toast").classList.remove("on");$("askTitle").textContent=`${r.title||"A game"} is running`;$("askText").textContent=`Quit it and start ${g.t}? Unsaved progress in the running game is lost.`;$("ask").hidden=false;
  $("askYes").onclick=()=>{$("ask").hidden=true;play(true)};$("askNo").onclick=()=>{$("ask").hidden=true}}
$("ask").addEventListener("click",e=>{if(e.target===$("ask"))$("ask").hidden=true});

/* ---------- the manual ---------- */
$("gManual").onclick=()=>{const g=curGame;if(!g||!(g.manual||[]).length)return;const box=$("mPages");box.innerHTML="";unlazy("m");
  $("mTitle").textContent=g.t;$("mCount").textContent=`${g.manual.length} pages`;
  g.manual.forEach((id,i)=>{const im=new Image();im.alt=`Page ${i+1}`;im.decoding="async";im.dataset.src=`/img/${id}?h=1600`;im.onload=()=>im.classList.add("in");box.append(im);lazy(im,"m",$("manual"))});
  $("manual").hidden=false;$("manual").scrollTop=0;history.pushState({v:"manual"},"")};
$("mClose").onclick=()=>history.back();
addEventListener("popstate",()=>{if(!$("ask").hidden){$("ask").hidden=true}if(!$("manual").hidden){$("manual").hidden=true;unlazy("m");$("mPages").innerHTML="";return}if(!$("game").hidden)closeGame()});

/* ---------- now playing ---------- */
async function pollStatus(){if(document.hidden||$("main").hidden)return;try{const s=await api("/api/status");running=s.running;setGlyphs(s.glyphs);
  $("nowPlaying").hidden=!running;if(running)$("nowTitle").textContent=running.title?`Playing ${running.title}`:"A game is running"}catch{}}
function startStatus(){stopStatus();pollStatus();statusT=setInterval(pollStatus,4000)}
function stopStatus(){clearInterval(statusT);statusT=0}
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&!$("main").hidden){pollStatus();if(lib)loadLibrary()}});
$("nowQuit").onclick=()=>{const t=running&&running.title||"the game";$("askTitle").textContent=`Quit ${t}?`;$("askText").textContent="Unsaved progress is lost.";$("askYes").textContent="Quit";$("ask").hidden=false;
  $("askYes").onclick=async()=>{$("ask").hidden=true;$("askYes").textContent="Quit and play";try{await api("/api/quit",{});toast("Closing the game…");setTimeout(pollStatus,2500)}catch(e){if(e.status!==401)toast(e.message)}};
  $("askNo").onclick=()=>{$("ask").hidden=true;$("askYes").textContent="Quit and play"}};

/* ---------- prompts in the pad style chosen in Boxshelf (Settings → Controller → Button prompts) ---------- */
const PS={bottom:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',right:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/></svg>',left:'<svg viewBox="0 0 24 24"><rect x="5.5" y="5.5" width="13" height="13" rx="1"/></svg>',top:'<svg viewBox="0 0 24 24"><path d="M12 4.5l8 14H4z"/></svg>'};
function setGlyphs(g){if(!g)return;const st=g.style==="ps"||g.style==="nintendo"?g.style:"xbox";if(st===glyph.style&&!!g.swap===glyph.swap&&$("fTop").dataset.st)return;glyph={style:st,swap:!!g.swap};
  const faces=document.querySelector(".faces");faces.className="faces "+st;
  const L=st==="nintendo"?{bottom:"B",right:"A",left:"Y",top:"X"}:{bottom:"A",right:"B",left:"X",top:"Y"};
  [["fBottom","bottom"],["fRight","right"],["fLeft","left"],["fTop","top"]].forEach(([id,pos])=>{const b=$(id);b.dataset.st=st;if(st==="ps")b.innerHTML=PS[pos];else b.textContent=L[pos]});
  $("bLB").textContent=st==="ps"?"L1":st==="nintendo"?"L":"LB";$("bRB").textContent=st==="ps"?"R1":st==="nintendo"?"R":"RB";
  $("bStart").textContent=st==="ps"?"Options":st==="nintendo"?"+":"Menu";$("bView").textContent=st==="ps"?"Create":st==="nintendo"?"−":"View"}

/* ---------- remote: press = down, release = up (held d-pad repeats on the TV like a real pad) ---------- */
let sendQ=Promise.resolve();
const sendIn=(b,d)=>{sendQ=sendQ.then(()=>api("/api/input",{b,d}).catch(e=>{if(e.net)toast(e.message)}))};
document.querySelectorAll(".rb").forEach(el=>{let id=null,keep=0;const b=el.dataset.b;
  const up=()=>{if(id===null)return;id=null;clearInterval(keep);el.classList.remove("held");sendIn(b,false)};
  el.addEventListener("pointerdown",e=>{e.preventDefault();if(id!==null)return;id=e.pointerId;try{el.setPointerCapture(id)}catch{}el.classList.add("held");buzz(8);sendIn(b,true);
    clearInterval(keep);keep=setInterval(()=>sendIn(b,true),450)}); // still held: the TV lets go by itself if these stop (a dropped connection can't leave a button stuck)
  el.addEventListener("pointerup",up);el.addEventListener("pointercancel",up);el.addEventListener("lostpointercapture",up);
  el.addEventListener("contextmenu",e=>e.preventDefault())});
addEventListener("blur",()=>document.querySelectorAll(".rb.held").forEach(el=>el.dispatchEvent(new PointerEvent("pointercancel"))));

/* ---------- keyboard: what changed in the box goes to the TV (autocorrect replacing a word = deletes + the new text) ---------- */
let kbPrev="",tq=Promise.resolve();
const sendT=o=>{tq=tq.then(()=>api("/api/text",o).catch(e=>{if(e.status!==401)toast(e.message)}))};
$("kb").addEventListener("input",e=>{const v=e.target.value;let i=0;while(i<v.length&&i<kbPrev.length&&v[i]===kbPrev[i])i++;
  for(let k=kbPrev.length;k>i;k--)sendT({key:"Backspace"});const add=v.slice(i);if(add)sendT({text:add});kbPrev=v});
$("kb").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();sendT({key:"Enter"})}else if(e.key==="Backspace"&&!e.target.value){sendT({key:"Backspace"})}});
$("kbBack").onclick=()=>{const v=$("kb").value;if(v){$("kb").value=v.slice(0,-1);kbPrev=$("kb").value}sendT({key:"Backspace"});buzz(8)};
$("kbEnter").onclick=()=>{sendT({key:"Enter"});buzz(8)};
$("kbClear").onclick=()=>{const n=$("kb").value.length;for(let k=0;k<n;k++)sendT({key:"Backspace"});$("kb").value="";kbPrev="";$("kb").focus()};

/* ---------- tabs ---------- */
document.querySelectorAll(".tabs button").forEach(b=>b.onclick=()=>{tab=b.dataset.tab;document.querySelectorAll(".tabs button").forEach(x=>x.classList.toggle("on",x===b));
  ["Library","Remote","Keys"].forEach(t=>$("tab"+t).hidden=t!==tab);scrollTo({top:0});if(tab==="Keys")setTimeout(()=>$("kb").focus(),60)});

start();
})();
