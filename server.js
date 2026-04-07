require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

let ngrokUrl=null;
app.get('/api/public-ip',(req,res)=>res.json({url:ngrokUrl}));

const WORDS = ['사과','바나나','자동차','집','나무','강아지','고양이','비행기','피자','햄버거','자전거','꽃','태양','달','별','물고기','로봇','케이크','안경','우산','신발','모자','시계','카메라','기타','피아노','축구공','아이스크림','커피','토끼','코끼리','기린','펭귄','드래곤','마녀','왕관','번개','무지개','화산','섬','배','기차','로켓','풍선','선인장','고래','곰','여우','부엉이','딸기'];
const PLAYER_COLORS = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F'];
const rooms = new Map();
function genRoomId(){const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return Array.from({length:4},()=>c[Math.floor(Math.random()*c.length)]).join('');}

io.on('connection',(socket)=>{
  socket.on('create_room',({nickname})=>{
    if(!nickname?.trim())return;
    const roomId=genRoomId();
    const player={id:socket.id,nickname:nickname.trim().slice(0,12),color:PLAYER_COLORS[0],isHost:true};
    const room={id:roomId,players:[player],state:'lobby',word:null,mafiaId:null,currentTurnIndex:0,voteCount:0,maxVotes:3,strokes:[],votes:{}};
    rooms.set(roomId,room);socket.join(roomId);socket.roomId=roomId;
    socket.emit('room_created',{roomId,player,players:room.players});
  });

  socket.on('join_room',({roomId,nickname})=>{
    if(!nickname?.trim()||!roomId)return;
    const id=roomId.trim().toUpperCase();const room=rooms.get(id);
    if(!room)return socket.emit('join_error',{message:'방을 찾을 수 없습니다.'});
    if(room.state!=='lobby')return socket.emit('join_error',{message:'게임이 이미 시작되었습니다.'});
    if(room.players.length>=8)return socket.emit('join_error',{message:'방이 가득 찼습니다.(최대 8명)'});
    const player={id:socket.id,nickname:nickname.trim().slice(0,12),color:PLAYER_COLORS[room.players.length%PLAYER_COLORS.length],isHost:false};
    room.players.push(player);socket.join(id);socket.roomId=id;
    socket.emit('joined_room',{roomId:id,player,players:room.players});
    socket.to(id).emit('player_joined',{players:room.players});
  });

  socket.on('start_game_early',()=>{
    const room=rooms.get(socket.roomId);
    if(!room||room.state!=='lobby')return;
    if(!room.players.find(p=>p.id===socket.id)?.isHost)return;
    startGame(socket.roomId);
  });

  socket.on('lobby_chat',({message})=>{
    const room=rooms.get(socket.roomId);
    if(!room||room.state!=='lobby')return;
    const player=room.players.find(p=>p.id===socket.id);
    if(!player||!message?.trim())return;
    io.to(socket.roomId).emit('lobby_chat',{nickname:player.nickname,color:player.color,message:message.trim().slice(0,100)});
  });

  socket.on('draw_stroke',({points})=>{
    const room=rooms.get(socket.roomId);if(!room||room.state!=='drawing')return;
    const cur=room.players[room.currentTurnIndex];if(!cur||cur.id!==socket.id||!points||points.length<2)return;
    const stroke={points,color:cur.color,playerId:socket.id,nickname:cur.nickname};
    room.strokes.push(stroke);io.to(socket.roomId).emit('stroke_added',{stroke});
    room.currentTurnIndex=(room.currentTurnIndex+1)%room.players.length;
    const next=room.players[room.currentTurnIndex];
    io.to(socket.roomId).emit('turn_changed',{currentPlayerId:next.id,currentPlayerName:next.nickname});
  });

  socket.on('propose_vote',()=>{
    const room=rooms.get(socket.roomId);
    if(!room||room.state!=='drawing'||room.voteCount>=room.maxVotes)return;
    room.state='voting';room.votes={};
    const proposer=room.players.find(p=>p.id===socket.id);
    io.to(socket.roomId).emit('vote_started',{proposerId:socket.id,proposerName:proposer?.nickname||'?',players:room.players,voteNumber:room.voteCount+1,maxVotes:room.maxVotes});
  });

  socket.on('cast_vote',({targetId})=>{
    const room=rooms.get(socket.roomId);
    if(!room||room.state!=='voting'||room.votes[socket.id])return;
    room.votes[socket.id]=targetId;
    io.to(socket.roomId).emit('vote_count_update',{votedCount:Object.keys(room.votes).length,totalCount:room.players.length});
    if(Object.keys(room.votes).length>=room.players.length)resolveVote(room);
  });

  socket.on('disconnect',()=>{
    const roomId=socket.roomId;if(!roomId)return;
    const room=rooms.get(roomId);if(!room)return;
    const leaving=room.players.find(p=>p.id===socket.id);
    room.players=room.players.filter(p=>p.id!==socket.id);
    if(room.players.length===0){rooms.delete(roomId);return;}
    if(leaving?.isHost)room.players[0].isHost=true;
    io.to(roomId).emit('player_left',{players:room.players,leftId:socket.id});
    if((room.state==='drawing'||room.state==='voting')&&socket.id===room.mafiaId){
      room.state='game_over';
      return io.to(roomId).emit('game_over',{winner:'citizens',mafiaId:socket.id,mafiaName:leaving?.nickname||'?',word:room.word,message:'마피아가 나갔습니다. 시민 승리!'});
    }
    if(room.state==='voting'){if(Object.keys(room.votes).length>=room.players.length)resolveVote(room);}
    else if(room.state==='drawing'){
      if(room.currentTurnIndex>=room.players.length)room.currentTurnIndex=0;
      const next=room.players[room.currentTurnIndex];
      if(next)io.to(roomId).emit('turn_changed',{currentPlayerId:next.id,currentPlayerName:next.nickname});
    }
  });
});

function startGame(roomId){
  const room=rooms.get(roomId);if(!room)return;
  if(room.players.length<3){io.to(roomId).emit('game_error',{message:'최소 3명이 필요합니다!'});return;}
  const word=WORDS[Math.floor(Math.random()*WORDS.length)];
  const mafiaIdx=Math.floor(Math.random()*room.players.length);
  const mafia=room.players[mafiaIdx];
  room.word=word;room.mafiaId=mafia.id;room.state='role_reveal';
  room.currentTurnIndex=0;room.strokes=[];room.voteCount=0;room.votes={};
  room.players.forEach(p=>{
    const sock=io.sockets.sockets.get(p.id);if(!sock)return;
    sock.emit('role_assigned',{role:p.id===mafia.id?'mafia':'citizen',word:p.id===mafia.id?null:word,players:room.players});
  });
  setTimeout(()=>{
    const r=rooms.get(roomId);if(!r||r.state!=='role_reveal')return;
    r.state='drawing';const first=r.players[0];
    io.to(roomId).emit('drawing_started',{currentPlayerId:first.id,currentPlayerName:first.nickname,players:r.players});
  },5000);
}

function resolveVote(room){
  const tally={};room.players.forEach(p=>{tally[p.id]=0;});
  Object.values(room.votes).forEach(tid=>{if(tally[tid]!==undefined)tally[tid]++;});
  let maxCnt=0,topId=null,isTie=false;
  Object.entries(tally).forEach(([id,cnt])=>{if(cnt>maxCnt){maxCnt=cnt;topId=id;isTie=false;}else if(cnt===maxCnt&&cnt>0)isTie=true;});
  const detail={};
  room.players.forEach(p=>{const target=room.players.find(pl=>pl.id===room.votes[p.id]);detail[p.id]={voterName:p.nickname,targetName:target?.nickname||'?'};});
  room.voteCount++;
  const mafiaFound=!isTie&&topId===room.mafiaId;
  const mafia=room.players.find(p=>p.id===room.mafiaId);
  if(mafiaFound){room.state='game_over';io.to(room.id).emit('game_over',{winner:'citizens',mafiaId:room.mafiaId,mafiaName:mafia?.nickname||'?',word:room.word,tally,detail,message:'시민 승리!'});}
  else if(room.voteCount>=room.maxVotes){room.state='game_over';io.to(room.id).emit('game_over',{winner:'mafia',mafiaId:room.mafiaId,mafiaName:mafia?.nickname||'?',word:room.word,tally,detail,message:'마피아 승리!'});}
  else{
    room.state='drawing';if(room.currentTurnIndex>=room.players.length)room.currentTurnIndex=0;
    const cur=room.players[room.currentTurnIndex];
    io.to(room.id).emit('vote_failed',{isTie,topId,tally,detail,votesUsed:room.voteCount,votesRemaining:room.maxVotes-room.voteCount,currentPlayerId:cur.id,currentPlayerName:cur.nickname});
  }
}

const PORT=process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',async()=>{
  console.log(`🎮 Drawfia → http://localhost:${PORT}`);
  const NGROK_TOKEN=process.env.NGROK_TOKEN;
  if(!NGROK_TOKEN){console.log('⚠️  NGROK_TOKEN 없음 - 외부접속 비활성화\n   → NGROK_TOKEN=your_token node server.js');return;}
  try{
    const ngrok=require('@ngrok/ngrok');
    const listener=await ngrok.forward({addr:PORT,authtoken:NGROK_TOKEN,response_header_add:['ngrok-skip-browser-warning: true']});
    ngrokUrl=listener.url();
    console.log(`🌐 외부접속  → ${ngrokUrl}`);
  }catch(e){console.log('🌐 ngrok 실패:',e.message);}
});