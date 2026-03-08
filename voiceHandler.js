const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState
} = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');

const activeConnections = new Map(); // guildId -> { connection, player, currentSong }
const audioBufferCache = new Map(); // songPath -> preloaded audio data

// preload the music
function preloadSong(songPath) {
  if (!audioBufferCache.has(songPath)) {
    if (fs.existsSync(songPath)) {
      const buffer = fs.readFileSync(songPath);
      audioBufferCache.set(songPath, buffer);
      console.log(`preloaded song: ${songPath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    } else {
      console.error(`song not found: ${songPath}`);
    }
  }
}

// preload multiple songs
function preloadSongs(songPaths) {
  console.log('preloading songs to the ram... ');
  for (const songPath of songPaths) {
    preloadSong(songPath);
  }
  console.log(`${audioBufferCache.size} songs preloaded`);
}

// create adio from the cached buffer
function createCachedAudioResource(songPath) {
  const buffer = audioBufferCache.get(songPath);
  if (!buffer) {
    throw new Error(`song not preloaded: ${songPath}`);
  }
  
  // stream from buffer
  const { Readable } = require('stream');
  const stream = Readable.from(buffer);
  
  return createAudioResource(stream, {
    inlineVolume: true
  });
}

async function joinAndPlay(voiceChannel, songPath, songName) {
  try {
    const guildId = voiceChannel.guild.id;

    // preload if not already preloaded
    preloadSong(songPath);

    // check if inside a channel in the server
    if (activeConnections.has(guildId)) {
      const existing = activeConnections.get(guildId);
      existing.connection.destroy();
      activeConnections.delete(guildId);
    }

    if (!fs.existsSync(songPath)) {
      throw new Error(`no audio file @${songPath}`);
    }

    // join voice channel
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    // wait for the bot to connect
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

    // generate adio player
    const player = createAudioPlayer();
    
    // to play the song using buffer
    const playSong = () => {
      const resource = createCachedAudioResource(songPath);
      player.play(resource);
      console.log(`playing ${songName} @${voiceChannel.guild.name}`);
    };

    // loop the song
    player.on(AudioPlayerStatus.Idle, () => {
      console.log(`again ${songName}`);
      playSong();
    });

    player.on('error', error => {
      console.error(`audio player error: ${error.message}`);
    });

    connection.subscribe(player); // dont forget to like and subscribe guys

    // start playing
    playSong();

    // conenction info
    activeConnections.set(guildId, {
      connection,
      player,
      currentSong: songName,
      channelId: voiceChannel.id
    });

    // disconnect
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch (error) {
        console.log(`left from $${voiceChannel.guild.name}`);
        connection.destroy();
        activeConnections.delete(guildId);
      }
    });

    return { connection, player, songName };

  } catch (error) {
    console.error('error when joining the vc: ', error);
    throw error;
  }
}

function leaveVoiceChannel(guildId) {
  const connectionInfo = activeConnections.get(guildId);
  
  if (connectionInfo) {
    connectionInfo.connection.destroy();
    activeConnections.delete(guildId);
    console.log(`left voice channel @${guildId}`);
    return true;
  }
  
  return false;
}

function isInVoiceChannel(guildId) {
  return activeConnections.has(guildId);
}

function getCurrentSong(guildId) {
  const connectionInfo = activeConnections.get(guildId);
  return connectionInfo ? { songName: connectionInfo.currentSong } : null;
}

module.exports = {
  joinAndPlay,
  leaveVoiceChannel,
  isInVoiceChannel,
  getCurrentSong,
  preloadSongs,
  preloadSong
};