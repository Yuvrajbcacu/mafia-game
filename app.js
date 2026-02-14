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

/* ===== ROLES ===== */

const ROLE_INFO={
  mafia:{team:"Mafia",text:"Choose someone to kill each night."},
  doctor:{team:"Village",text:"Choose someone to save."},
  detective:{team:"Village",text:"Check if someone is mafia."},
  silencer:{team:"Village",text:"Mute one player from voting next day."},
  fool:{team:"Neutral",text:"Get voted out to win instantly."},
  villager:{team:"Village",text:"Discuss and vote."}
};

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
    detectiveResult:null
  });

  show("playerScreen");
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
      html += `<div>${d.alive?"🟢":"💀"} ${d.name}</div>`;
    });

    if(isHost){
      playerListHost.innerHTML=html;
      checkNightDone();
      checkVotesDone();
    }else{
      playerListPlayer.innerHTML=html;
    }
  });

  if(!isHost){
    onSnapshot(doc(db,"rooms",currentRoom,"players",user.uid),snap=>{
      const me=snap.data();
      if(!me?.role) return;

      const info=ROLE_INFO[me.role];
      roleText.innerText=
        `Role: ${me.role}\nTeam: ${info.team}\n${info.text}`;

      if(me.detectiveResult){
        roleText.innerText += `\n\n${me.detectiveResult}`;
      }
    });
  }
}

/* ===== ROLE ASSIGN ===== */

async function assignRoles(){

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const ids=[]; snap.forEach(p=>ids.push(p.id));

  if(ids.length!==7){
    alert("Need exactly 7 players");
    return;
  }

  const roles=[
    "mafia","doctor","detective",
    "fool","silencer","villager","villager"
  ];

  shuffle(roles);

  for(let i=0;i<ids.length;i++){
    await updateDoc(doc(db,"rooms",currentRoom,"players",ids[i]),{
      role:roles[i]
    });
  }

  await updateDoc(doc(db,"rooms",currentRoom),{
    phase:"NIGHT",
    announcement:"🌙 Night started."
  });
}

/* ===== ACTION UI ===== */

async function renderActions(phase){

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
    if(me.silenced){ actionArea.innerHTML="🔇 You are silenced."; return; }

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

/* ===== ACTIONS ===== */

async function selectTarget(uid,name){
  actionArea.innerHTML=`🌙 Selected: <b>${name}</b>`;
  await updateDoc(doc(db,"rooms",currentRoom,"players",user.uid),{
    target:uid,actionSubmitted:true
  });
}

async function votePlayer(uid,name){
  actionArea.innerHTML=`✅ You voted: <b>${name}</b>`;
  await updateDoc(doc(db,"rooms",currentRoom,"players",user.uid),{
    vote:uid
  });
}

/* ===== NIGHT ===== */

async function checkNightDone(){
  const room=(await getDoc(doc(db,"rooms",currentRoom))).data();
  if(!isHost || room.phase!=="NIGHT") return;

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

  const players=await getAlivePlayers();

  const mafia=players.find(p=>p.role==="mafia");
  const doctor=players.find(p=>p.role==="doctor");
  const silencer=players.find(p=>p.role==="silencer");
  const detective=players.find(p=>p.role==="detective");

  let kill=mafia?.target;
  if(kill===doctor?.target) kill=null;

  if(kill) await updateDoc(doc(db,"rooms",currentRoom,"players",kill),{alive:false});
  if(silencer?.target) await updateDoc(doc(db,"rooms",currentRoom,"players",silencer.target),{silenced:true});

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

  const dead=players.find(p=>p.id===kill)?.name||"Nobody";

  await updateDoc(doc(db,"rooms",currentRoom),{
    phase:"DAY",
    announcement:`☀️ Day started. ${dead} died last night.`
  });

  resetActions();
}

/* ===== VOTING ===== */

async function checkVotesDone(){
  const room=(await getDoc(doc(db,"rooms",currentRoom))).data();
  if(!isHost || room.phase!=="VOTING") return;

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const alive=[];
  snap.forEach(p=>{
    const d=p.data();
    if(d.alive && !d.silenced && d.role) alive.push(d);
  });

  if(alive.length && alive.every(p=>p.vote)) resolveVoting();
}

async function resolveVoting(){

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const votes={},players=[];

  snap.forEach(p=>{
    const d=p.data();
    players.push({id:p.id,...d});
    if(d.alive&&d.vote) votes[d.vote]=(votes[d.vote]||0)+1;
  });

  let max=0,ties=[];
  for(const id in votes){
    if(votes[id]>max){ max=votes[id]; ties=[id]; }
    else if(votes[id]===max){ ties.push(id); }
  }

  if(ties.length!==1){
    await updateDoc(doc(db,"rooms",currentRoom),{
      phase:"VOTE_RESULT",
      announcement:"⚖️ Vote tied. Nobody eliminated."
    });
    resetVotes();
    return;
  }

  const top=ties[0];
  await updateDoc(doc(db,"rooms",currentRoom,"players",top),{alive:false});

  await updateDoc(doc(db,"rooms",currentRoom),{
    phase:"VOTE_RESULT",
    announcement:`🗳️ Player eliminated.`
  });

  resetVotes();
}

/* ===== HOST BUTTON ===== */

nextPhaseBtn.onclick=async()=>{
  const roomRef=doc(db,"rooms",currentRoom);
  const room=(await getDoc(roomRef)).data();

  if(room.phase==="LOBBY"){ assignRoles(); return; }

  if(room.phase==="DAY"){
    await resetVotes();
    await updateDoc(roomRef,{phase:"VOTING",announcement:"🗳️ Voting started."});
  }

  if(room.phase==="VOTE_RESULT"){
    await updateDoc(roomRef,{
      phase:"NIGHT",
      round:room.round+1,
      announcement:"🌙 New night begins."
    });
    clearSilence();
  }
};

/* ===== HELPERS ===== */

async function getAlivePlayers(){
  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const arr=[]; snap.forEach(p=>{ if(p.data().alive) arr.push({id:p.id,...p.data()}); });
  return arr;
}

async function resetActions(){
  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  for(const p of snap.docs){
    await updateDoc(p.ref,{
      actionSubmitted:false,
      target:null
    });
  }
}

async function resetVotes(){
  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  for(const p of snap.docs) await updateDoc(p.ref,{vote:null});
}

async function clearSilence(){
  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  for(const p of snap.docs) await updateDoc(p.ref,{silenced:false});
}

function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
}