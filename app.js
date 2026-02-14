import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup }
from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

import {
  getFirestore, doc, setDoc, getDoc,
  updateDoc, onSnapshot, collection, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

/* ===== INIT ===== */

initializeApp(firebaseConfig);
const auth = getAuth();
const db = getFirestore();

let user=null,currentRoom=null,isHost=false;
let lastPhase=null;

let resolvingNight=false;
let resolvingVote=false;

let roomListenerUnsub=null;
let playersListenerUnsub=null;
let heartbeatInterval=null;

/* ===== ROLES ===== */

const ROLE_INFO={
  mafia:{team:"Mafia",text:"Choose someone to kill each night."},
  doctor:{team:"Village",text:"Choose someone to save."},
  detective:{team:"Village",text:"Check if someone is mafia."},
  silencer:{team:"Mafia",text:"Mute one player from voting next day."},
  fool:{team:"Neutral",text:"Get voted out to win instantly."},
  villager:{team:"Village",text:"Discuss and vote."}
};

/* ===== UI ===== */

function show(id){
  document.querySelectorAll(".screen").forEach(s=>s.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

/* ===== ACTIVE / HEARTBEAT ===== */

const HEARTBEAT_MS = 5000;
const ACTIVE_TIMEOUT_MS = 15000;

async function markActive(){
  if(!currentRoom || !user) return;
  try{
    await updateDoc(
      doc(db,"rooms",currentRoom,"players",user.uid),
      { lastSeen: Date.now(), connected:true }
    );
  }catch(e){}
}

function startHeartbeat(){
  stopHeartbeat();
  markActive();
  heartbeatInterval=setInterval(markActive,HEARTBEAT_MS);
}

function stopHeartbeat(){
  if(heartbeatInterval){
    clearInterval(heartbeatInterval);
    heartbeatInterval=null;
  }
}

function isPlayerActive(p){
  if(!p) return false;
  if(!p.connected) return false;
  if(!p.lastSeen) return false;
  return (Date.now()-p.lastSeen) <= ACTIVE_TIMEOUT_MS;
}

window.addEventListener("beforeunload", async ()=>{
  try{
    if(currentRoom && user){
      await updateDoc(
        doc(db,"rooms",currentRoom,"players",user.uid),
        { connected:false, lastSeen:Date.now() }
      );
    }
  }catch(e){}
});

/* ===== ROLE RENDER (STABLE) ===== */

let cachedMeData = null;

function renderRoleFromData(me){
  if(isHost) return;
  if(!me || !me.role){
    roleText.innerText="Role assigning...";
    return;
  }

  const info=ROLE_INFO[me.role];
  let txt=`Role: ${me.role}\nTeam: ${info.team}\n${info.text}`;

  if(me.detectiveResult){
    txt += `\n\n${me.detectiveResult}`;
  }

  roleText.innerText=txt;
}

async function renderRoleInfo(){
  if(isHost) return;

  if(cachedMeData){
    renderRoleFromData(cachedMeData);
    return;
  }

  const snap = await getDoc(
    doc(db,"rooms",currentRoom,"players",user.uid)
  );

  const me = snap.data();
  cachedMeData = me || null;
  renderRoleFromData(me);
}

/* ===== LOGIN ===== */

loginBtn.onclick=async()=>{
  const res=await signInWithPopup(auth,new GoogleAuthProvider());
  user=res.user;
  show("lobbyScreen");
};

guestLoginBtn.onclick=()=>{
  const name=guestName.value.trim();
  if(!name) return alert("Enter name");

  user={
    uid:"guest_"+Math.random().toString(36).slice(2,9),
    displayName:name
  };

  show("lobbyScreen");
};

/* ===== ROOM ===== */

createRoom.onclick=async()=>{
  const roomId=Math.random().toString(36).substring(2,7);

  await setDoc(doc(db,"rooms",roomId),{
    phase:"LOBBY",
    round:1,
    hostId:user.uid,
    announcement:"Waiting for players..."
  });

  currentRoom=roomId;
  isHost=true;
  show("hostScreen");
  listenRoom();
};

joinRoom.onclick=async()=>{
  currentRoom=roomIdInput.value.trim();

  await setDoc(doc(db,"rooms",currentRoom,"players",user.uid),{
    name:user.displayName,
    role:null,
    alive:true,
    vote:null,
    target:null,
    actionSubmitted:false,
    silenced:false,
    detectiveResult:null,
    connected:true,
    lastSeen:Date.now()
  });

  show("playerScreen");
  myName.innerText="You: "+user.displayName;
  listenRoom();
  startHeartbeat();
};

/* ===== LISTEN ===== */

function listenRoom(){

  if(roomListenerUnsub) roomListenerUnsub();
  if(playersListenerUnsub) playersListenerUnsub();

  roomListenerUnsub = onSnapshot(doc(db,"rooms",currentRoom),snap=>{
    const room=snap.data();
    if(!room) return;

    if(isHost){
      hostRoomCode.innerText=`Room Code: ${currentRoom}`;
      hostAnnouncement.innerText=`Round ${room.round}\n${room.announcement}`;
    }else{
      phaseText.innerText=room.phase;

      if(room.phase!==lastPhase){
        lastPhase=room.phase;
        renderRoleInfo();
        renderActions(room.phase);
      }else{
        renderRoleInfo();
      }
    }
  });

  playersListenerUnsub = onSnapshot(collection(db,"rooms",currentRoom,"players"),snap=>{

    let html="<h3>Players</h3>";

    snap.forEach(p=>{
      const d=p.data();
      const meTag=(p.id===user.uid)?" (You)":"";
      const active=isPlayerActive(d);
      html+=`<div>${d.alive?"🟢":"💀"} ${d.name}${meTag}${active?"":" (dc)"}</div>`;

      if(p.id===user.uid){
        cachedMeData=d;
        renderRoleFromData(d);
      }
    });

    if(isHost){
      playerListHost.innerHTML=html;
      checkNightDone();
      checkVotesDone();
    }else{
      playerListPlayer.innerHTML=html;
    }
  });
}

/* ===== ROLE ASSIGN ===== */

async function assignRoles(){

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const ids=[]; snap.forEach(p=>ids.push(p.id));

  if(ids.length!==7){
    alert("Need exactly 7 players");
    return;
  }

  const roles=["mafia","doctor","detective","fool","silencer","villager","villager"];
  shuffle(roles);

  for(let i=0;i<ids.length;i++){
    await updateDoc(doc(db,"rooms",currentRoom,"players",ids[i]),{
      role:roles[i],
      alive:true,
      silenced:false,
      vote:null,
      target:null,
      actionSubmitted:false,
      detectiveResult:null
    });
  }

  await updateDoc(doc(db,"rooms",currentRoom),{
    phase:"NIGHT",
    announcement:"🌙 Night started."
  });
}

/* ===== ACTION UI ===== */

async function renderActions(phase){

  await renderRoleInfo();

  const me=(await getDoc(doc(db,"rooms",currentRoom,"players",user.uid))).data();
  if(!me?.alive){ actionArea.innerHTML="💀 You are dead."; return; }

  actionArea.innerHTML="";
  const players=await getAlivePlayers();

  if(phase==="NIGHT"){
    if(["villager","fool"].includes(me.role)){
      actionArea.innerHTML="Waiting for night...";
      return;
    }

    players.forEach(p=>{
      if(p.id===user.uid) return;
      const btn=document.createElement("button");
      btn.className="playerBtn";
      btn.textContent=p.name;
      btn.onclick=()=>selectTarget(p.id,p.name);
      actionArea.appendChild(btn);
    });
  }

  if(phase==="VOTING"){
    if(me.silenced){
      actionArea.innerHTML="🔇 You are silenced and cannot vote.";
      return;
    }

    players.forEach(p=>{
      if(p.id===user.uid) return;
      const btn=document.createElement("button");
      btn.className="playerBtn";
      btn.textContent=p.name;
      btn.onclick=()=>votePlayer(p.id,p.name);
      actionArea.appendChild(btn);
    });

    const skipBtn=document.createElement("button");
    skipBtn.className="playerBtn";
    skipBtn.textContent="⏭️ Skip Vote";
    skipBtn.onclick=()=>votePlayer("SKIP","Skip");
    actionArea.appendChild(skipBtn);
  }
}

/* ===== ACTIONS ===== */

async function selectTarget(uid,name){
  actionArea.innerHTML=`🌙 Selected: <b>${name}</b>`;
  await updateDoc(doc(db,"rooms",currentRoom,"players",user.uid),{
    target:uid,
    actionSubmitted:true
  });
}

async function votePlayer(uid,name){

  const me=(await getDoc(doc(db,"rooms",currentRoom,"players",user.uid))).data();
  if(me.silenced) return;

  actionArea.innerHTML=`✅ You voted: <b>${name}</b>`;
  await updateDoc(doc(db,"rooms",currentRoom,"players",user.uid),{
    vote:uid
  });
}

/* ===== NIGHT ===== */

async function checkNightDone(){
  if(resolvingNight) return;

  const room=(await getDoc(doc(db,"rooms",currentRoom))).data();
  if(!isHost||room.phase!=="NIGHT") return;

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  let done=true;

  snap.forEach(p=>{
    const d=p.data();
    if(!d.alive||!d.role) return;
    if(!isPlayerActive(d)) return;

    if(["mafia","doctor","detective","silencer"].includes(d.role)){
      if(!d.actionSubmitted) done=false;
    }
  });

  if(done) resolveNight();
}

async function resolveNight(){

  if(resolvingNight) return;
  resolvingNight=true;

  const room=(await getDoc(doc(db,"rooms",currentRoom))).data();
  if(!isHost || room.phase!=="NIGHT"){
    resolvingNight=false;
    return;
  }

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const players=[]; snap.forEach(p=>players.push({id:p.id,...p.data()}));

  const mafia=players.find(p=>p.role==="mafia"&&p.alive&&isPlayerActive(p));
  const doctor=players.find(p=>p.role==="doctor"&&p.alive&&isPlayerActive(p));
  const detective=players.find(p=>p.role==="detective"&&p.alive&&isPlayerActive(p));
  const silencer=players.find(p=>p.role==="silencer"&&p.alive&&isPlayerActive(p));

  let kill=mafia?.target||null;
  if(kill===doctor?.target) kill=null;

  if(kill){
    await updateDoc(doc(db,"rooms",currentRoom,"players",kill),{alive:false});
  }

  if(silencer?.target){
    await updateDoc(doc(db,"rooms",currentRoom,"players",silencer.target),{
      silenced:true
    });
  }

  if(detective?.target){
    const checked=players.find(p=>p.id===detective.target);
    if(checked){
      await updateDoc(doc(db,"rooms",currentRoom,"players",detective.id),{
        detectiveResult: checked.role==="mafia"
          ? `🕵️ ${checked.name} is MAFIA`
          : `🕵️ ${checked.name} is NOT mafia`
      });
    }
  }

  const dead=players.find(p=>p.id===kill)?.name || "Nobody";

  await updateDoc(doc(db,"rooms",currentRoom),{
    phase:"DAY",
    announcement:`☀️ Day started. ${dead} died last night.`
  });

  await resetActions();

  const ended=await checkWin();
  if(ended){
    resolvingNight=false;
    return;
  }

  resolvingNight=false;
}

/* ===== VOTING ===== */

async function checkVotesDone(){
  if(resolvingVote) return;

  const room=(await getDoc(doc(db,"rooms",currentRoom))).data();
  if(!isHost||room.phase!=="VOTING") return;

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const alive=[];

  snap.forEach(p=>{
    const d=p.data();
    if(d.alive && !d.silenced && d.role && isPlayerActive(d)) alive.push(d);
  });

  if(alive.length && alive.every(p=>p.vote)) resolveVoting();
}

async function resolveVoting(){

  if(resolvingVote) return;
  resolvingVote=true;

  const room=(await getDoc(doc(db,"rooms",currentRoom))).data();
  if(!isHost || room.phase!=="VOTING"){
    resolvingVote=false;
    return;
  }

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const players=[];
  const votes={};

  snap.forEach(p=>{
    const d={id:p.id,...p.data()};
    players.push(d);

    if(d.alive && d.vote && !d.silenced && isPlayerActive(d)){
      votes[d.vote]=(votes[d.vote]||0)+1;
    }
  });

  let max=0,top=null;
  for(const id in votes){
    if(votes[id]>max){ max=votes[id]; top=id; }
  }

  let votedOutName="Nobody";
  let votedOutRole=null;

  if(top && top!=="SKIP"){
    const target=players.find(p=>p.id===top);
    votedOutName=target?.name || "Unknown";
    votedOutRole=target?.role || null;

    await updateDoc(doc(db,"rooms",currentRoom,"players",top),{alive:false});
  }

  if(top==="SKIP"){
    votedOutName="Nobody (Vote Skipped)";
  }

  if(votedOutRole==="fool"){
    await endGame(`🤡 ${votedOutName} (Fool) got voted out and wins instantly!`);
    await resetVotes();
    resolvingVote=false;
    return;
  }

  const ended=await checkWin();

  if(!ended){
    await updateDoc(doc(db,"rooms",currentRoom),{
      phase:"VOTE_RESULT",
      announcement:`🗳️ Voting finished. ${votedOutName} was voted out.`
    });
  }

  await resetVotes();
  resolvingVote=false;
}

/* ===== HOST ===== */

nextPhaseBtn.onclick=async()=>{
  const roomRef=doc(db,"rooms",currentRoom);
  const room=(await getDoc(roomRef)).data();

  if(room.phase==="GAME_END"){
    const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
    for(const p of snap.docs){
      await updateDoc(p.ref,{
        role:null,
        alive:true,
        vote:null,
        target:null,
        actionSubmitted:false,
        silenced:false,
        detectiveResult:null,
        connected:true,
        lastSeen:Date.now()
      });
    }

    await updateDoc(roomRef,{
      phase:"LOBBY",
      round:1,
      announcement:"Waiting for players..."
    });
    return;
  }

  if(room.phase==="LOBBY"){ assignRoles(); return; }

  if(room.phase==="DAY"){
    await resetVotes();
    await updateDoc(roomRef,{phase:"VOTING",announcement:"🗳️ Voting started."});
  }

  if(room.phase==="VOTE_RESULT"){
    await clearSilence();
    await updateDoc(roomRef,{
      phase:"NIGHT",
      round:room.round+1,
      announcement:"🌙 New night begins."
    });
  }
};

/* ===== HELPERS ===== */

async function getAlivePlayers(){
  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const arr=[]; 
  snap.forEach(p=>{
    if(p.data().alive) arr.push({id:p.id,...p.data()});
  });
  return arr;
}

async function resetActions(){
  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  for(const p of snap.docs){
    await updateDoc(p.ref,{actionSubmitted:false,target:null});
  }
}

async function resetVotes(){
  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  for(const p of snap.docs){
    await updateDoc(p.ref,{vote:null});
  }
}

async function checkWin(){

  const alive = await getAlivePlayers();
  const mafiaAlive = alive.some(p=>p.role==="mafia");

  if(!mafiaAlive){
    await endGame("🏆 Village wins! Mafia eliminated.");
    return true;
  }

  if(alive.length<=3){
    await endGame("💀 Mafia wins!");
    return true;
  }

  return false;
}

async function clearSilence(){
  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  for(const p of snap.docs){
    await updateDoc(p.ref,{silenced:false});
  }
}

async function endGame(msg){
  await updateDoc(doc(db,"rooms",currentRoom),{
    phase:"GAME_END",
    announcement:msg
  });
}

function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
}