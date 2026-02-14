import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth,GoogleAuthProvider,signInWithPopup }
from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
  getFirestore,doc,setDoc,getDoc,updateDoc,onSnapshot,
  collection,getDocs
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

/* ===== INIT ===== */

const app = initializeApp(firebaseConfig);
const auth = getAuth();
const db = getFirestore();

let user=null,currentRoom=null,isHost=false;

/* ===== ROLE INFO ===== */

const ROLE_INFO={
  mafia:{team:"Mafia",text:"Choose someone to kill each night."},
  doctor:{team:"Village",text:"Choose someone to save."},
  detective:{team:"Village",text:"Check if someone is mafia."},
  bodyguard:{team:"Village",text:"Protect someone. You may die instead."},
  silencer:{team:"Village",text:"Mute one player from voting next day."},
  fool:{team:"Neutral",text:"Get voted out to win instantly."},
  villager:{team:"Village",text:"Discuss and vote."}
};

/* ===== UI ===== */

function show(id){
  document.querySelectorAll(".screen")
    .forEach(s=>s.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

/* ===== LOGIN ===== */

loginBtn.onclick=async()=>{
  const res=await signInWithPopup(auth,new GoogleAuthProvider());
  user=res.user;
  show("lobbyScreen");
};

/* ===== CREATE ROOM ===== */

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

  alert("Room Code: "+roomId);

  show("hostScreen");
  listenRoom();
};

/* ===== JOIN ===== */

joinRoom.onclick=async()=>{
  currentRoom=roomIdInput.value.trim();

  await setDoc(doc(db,"rooms",currentRoom,"players",user.uid),{
    name:user.displayName,
    role:null,
    alive:true,
    vote:null,
    target:null,
    actionSubmitted:false,
    silenced:false
  });

  show("playerScreen");
  listenRoom();
};

/* ===== LISTEN ===== */

function listenRoom(){

  onSnapshot(doc(db,"rooms",currentRoom),snap=>{
    const room=snap.data();

    if(isHost){
      hostAnnouncement.innerText =
        `Round ${room.round}\n${room.announcement}`;
    }else{
      phaseText.innerText = room.phase;
      renderActions(room.phase);
    }
  });

  /* ===== PASTE HERE ===== */

  onSnapshot(
    collection(db,"rooms",currentRoom,"players"),
    (snap)=>{

      let html = "<h3>Players</h3>";

      snap.forEach(p=>{
        const d = p.data();
        const status = d.alive ? "🟢" : "💀";
        html += `<div>${status} ${d.name}</div>`;
      });

      if(isHost){
        document.getElementById("playerListHost").innerHTML = html;
      } else {
        document.getElementById("playerListPlayer").innerHTML = html;
      }
    }
  );

  /* ===== END PASTE ===== */

  if(!isHost){
    onSnapshot(doc(db,"rooms",currentRoom,"players",user.uid),snap=>{
      const me=snap.data();
      if(!me?.role) return;

      const info=ROLE_INFO[me.role];
      roleText.innerText =
        `Role: ${me.role}\nTeam: ${info.team}\n${info.text}`;
    });
  }
}



/* ===== ROLE ASSIGN ===== */

async function assignRoles(){

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  const ids=[]; snap.forEach(p=>ids.push(p.id));

  if(ids.length!==8){ alert("Need exactly 8 players"); return; }

  const roles=[
    "mafia","doctor","detective","bodyguard",
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

/* ===== PLAYER ACTIONS ===== */

async function renderActions(phase){

  const meSnap=await getDoc(doc(db,"rooms",currentRoom,"players",user.uid));
  const me=meSnap.data();

  if(!me.alive){
    actionArea.innerHTML="💀 You are dead. Watching game.";
    return;
  }

  if(phase==="NIGHT"){

    if(["villager","fool"].includes(me.role)){
      actionArea.innerHTML="Waiting for night...";
      return;
    }

    const players=await getAlivePlayers();
    actionArea.innerHTML="";

    players.forEach(p=>{
      if(p.id===user.uid) return;
      actionArea.innerHTML +=
      `<button class="playerBtn" onclick="selectTarget('${p.id}')">${p.name}</button>`;
    });
  }

  if(phase==="VOTING"){

    if(me.silenced){
      actionArea.innerHTML="🔇 You are silenced today.";
      return;
    }

    const players=await getAlivePlayers();
    actionArea.innerHTML="";

    players.forEach(p=>{
      if(p.id===user.uid) return;
      actionArea.innerHTML +=
      `<button class="playerBtn" onclick="votePlayer('${p.id}')">${p.name}</button>`;
    });
  }
}

/* ===== SELECT ACTION ===== */

window.selectTarget=async(uid)=>{
  await updateDoc(doc(db,"rooms",currentRoom,"players",user.uid),{
    target:uid,
    actionSubmitted:true
  });
  checkNightDone();
};

window.votePlayer=async(uid)=>{
  await updateDoc(doc(db,"rooms",currentRoom,"players",user.uid),{
    vote:uid
  });
  checkVotesDone();
};

/* ===== NIGHT ===== */

async function checkNightDone(){

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  let done=true;

  snap.forEach(p=>{
    const d=p.data();
    if(!d.alive) return;
    if(["mafia","doctor","detective","bodyguard","silencer"].includes(d.role)){
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

  let killTarget=mafia?.target;
  const saveTarget=doctor?.target;
  const silenceTarget=silencer?.target;

  if(killTarget===saveTarget) killTarget=null;

  if(killTarget){
    await updateDoc(doc(db,"rooms",currentRoom,"players",killTarget),
      {alive:false});
  }

  if(silenceTarget){
    await updateDoc(doc(db,"rooms",currentRoom,"players",silenceTarget),
      {silenced:true});
  }

  const deadName=players.find(p=>p.id===killTarget)?.name || "Nobody";

  await updateDoc(doc(db,"rooms",currentRoom),{
    phase:"DAY",
    announcement:`☀️ Day started. ${deadName} died last night.`
  });

  await resetActions();
  await checkWin();
}

/* ===== VOTING ===== */

async function checkVotesDone(){

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  let done=true;

  snap.forEach(p=>{
    const d=p.data();
    if(!d.alive||d.silenced) return;
    if(!d.vote) done=false;
  });

  if(done) resolveVoting();
}

async function resolveVoting(){

  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));

  const votes={}, players=[];

  snap.forEach(p=>{
    const d=p.data();
    players.push({id:p.id,...d});

    if(d.alive && d.vote){
      votes[d.vote]=(votes[d.vote]||0)+1;
    }
  });

  let top=null,max=0;
  for(const id in votes){
    if(votes[id]>max){ max=votes[id]; top=id; }
  }

  if(top){
    await updateDoc(doc(db,"rooms",currentRoom,"players",top),
      {alive:false});

    const eliminated=players.find(p=>p.id===top);

    if(eliminated.role==="fool"){
      await endGame("🤡 Fool wins!");
      return;
    }

    await updateDoc(doc(db,"rooms",currentRoom),{
      phase:"VOTE_RESULT",
      announcement:`🗳️ ${eliminated.name} was voted out.`
    });
  }

  await resetVotes();
  await checkWin();
}

/* ===== WIN CONDITIONS ===== */

async function checkWin(){

  const alive=await getAlivePlayers();

  const mafiaAlive=alive.some(p=>p.role==="mafia");

  if(!mafiaAlive){
    await endGame("🏆 Village wins!");
    return;
  }

  if(alive.length<=3){
    await endGame("💀 Mafia wins! 3 players remain.");
  }
}

async function endGame(msg){
  await updateDoc(doc(db,"rooms",currentRoom),{
    phase:"GAME_END",
    announcement:msg
  });
}

/* ===== HOST ===== */

nextPhaseBtn.onclick=async()=>{
  const roomRef=doc(db,"rooms",currentRoom);
  const room=(await getDoc(roomRef)).data();

  if(room.phase==="LOBBY"){ assignRoles(); return; }

  if(room.phase==="DAY"){
    await updateDoc(roomRef,{
      phase:"VOTING",
      announcement:"🗳️ Voting started."
    });
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

async function clearSilence(){
  const snap=await getDocs(collection(db,"rooms",currentRoom,"players"));
  for(const p of snap.docs){
    await updateDoc(p.ref,{silenced:false});
  }
}

function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
}