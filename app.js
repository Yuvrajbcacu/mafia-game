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
const auth=getAuth();
const db=getFirestore();

let user=null,currentRoom=null,isHost=false;
let lastPhase=null;
let resolvingNight=false;
let resolvingVote=false;

/* ===== UI ===== */

function show(id){
  document.querySelectorAll(".screen").forEach(s=>s.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
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
  user={uid:"guest_"+Math.random().toString(36).slice(2,9),displayName:name};
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
    detectiveResult:null
  });

  show("playerScreen");
  myName.innerText="You: "+user.displayName;
  listenRoom();
};

/* ===== LISTEN ===== */

function listenRoom(){

  onSnapshot(doc(db,"rooms",currentRoom),snap=>{
    const room=snap.data();
    if(!room) return;

    if(isHost){
      hostRoomCode.innerText=`Room Code: ${currentRoom}`;
      hostAnnouncement.innerText=`Round ${room.round}\n${room.announcement}`;
    }else{
      phaseText.innerText=room.phase;

      if(room.phase!==lastPhase){
        lastPhase=room.phase;
        renderActions(room.phase);
      }
    }
  });

  onSnapshot(collection(db,"rooms",currentRoom,"players"),snap=>{
    let html="<h3>Players</h3>";

    snap.forEach(p=>{
      const d=p.data();
      const meTag = (p.id===user.uid) ? " (You)" : "";
      html += `<div>${d.alive?"🟢":"💀"} ${d.name}${meTag}</div>`;
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

  if(ids.length!==7){ alert("Need exactly 7 players"); return; }

  const roles=["mafia","doctor","detective","fool","silencer","villager","villager"];

  shuffle(roles);

  for(let i=0;i<ids.length;i++){
    await updateDoc(doc(db,"rooms",currentRoom,"players",ids[i]),{role:roles[i]});
  }

  await updateDoc(doc(db,"rooms",currentRoom),{
    phase:"NIGHT",
    announcement:"🌙 Night started."
  });
}

/* ===== ACTIONS ===== */

async function renderActions(phase){
  const me=(await getDoc(doc(db,"rooms",currentRoom,"players",user.uid))).data();
  if(!me?.alive){ actionArea.innerHTML="💀 You are dead."; return; }

  actionArea.innerHTML="";
  const players=await getAlivePlayers();

  if(phase==="NIGHT"){
    if(["villager","fool"].includes(me.role)){ actionArea.innerHTML="Waiting for night..."; return; }

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
    players.forEach(p=>{
      if(p.id===user.uid) return;
      const btn=document.createElement("button");
      btn.className="playerBtn";
      btn.textContent=p.name;
      btn.onclick=()=>votePlayer(p.id,p.name);
      actionArea.appendChild(btn);
    });
  }
}

async function selectTarget(uid,name){
  actionArea.innerHTML=`🌙 Selected: <b>${name}</b>`;
  await updateDoc(doc(db,"rooms",currentRoom,"players",user.uid),{
    target:uid,actionSubmitted:true
  });
}

async function votePlayer(uid,name){
  actionArea.innerHTML=`✅ You voted: <b>${name}</b>`;
  await updateDoc(doc(db,"rooms",currentRoom,"players",user.uid),{vote:uid});
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
    if(["mafia","doctor","detective","silencer"].includes(d.role)){
      if(!d.actionSubmitted) done=false;
    }
  });

  if(done) resolveNight();
}

async function resolveNight(){
  resolvingNight=true;

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const players=[];
  snap.forEach(p=>players.push({id:p.id,...p.data()}));

  const mafia=players.find(p=>p.role==="mafia"&&p.alive);
  let kill=mafia?.target||null;

  if(kill){
    await updateDoc(doc(db,"rooms",currentRoom,"players",kill),{alive:false});
  }

  const dead=players.find(p=>p.id===kill)?.name||"Nobody";

  await updateDoc(doc(db,"rooms",currentRoom),{
    phase:"DAY",
    announcement:`☀️ Day started. ${dead} died last night.`
  });

  resolvingNight=false;
}

/* ===== VOTE ===== */

async function checkVotesDone(){
  if(resolvingVote) return;
  const room=(await getDoc(doc(db,"rooms",currentRoom))).data();
  if(!isHost||room.phase!=="VOTING") return;

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const alive=[];
  snap.forEach(p=>{ const d=p.data(); if(d.alive&&d.role) alive.push(d); });

  if(alive.length && alive.every(p=>p.vote)) resolveVoting();
}

async function resolveVoting(){
  resolvingVote=true;
  // existing vote logic here...
  resolvingVote=false;
}

/* ===== HELPERS ===== */

async function getAlivePlayers(){
  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const arr=[]; snap.forEach(p=>{ if(p.data().alive) arr.push({id:p.id,...p.data()}); });
  return arr;
}

function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
}