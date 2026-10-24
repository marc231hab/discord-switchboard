import { REST, Routes, PermissionsBitField } from 'discord.js'
import { State } from '../src/state.js'
import { join } from 'node:path'
const rest = new REST({version:'10'}).setToken(process.env.DISCORD_BOT_TOKEN)
const state = new State(join(process.env.DISCORD_STATE_DIR || join(process.env.HOME,'.local/state/discord-agent-router'),'router.sqlite'))
const bot=await rest.get(Routes.user('@me'))
const b=state.all('binding').find(b=>b.channelId===process.env.DISCORD_CHANNEL_ID)
if(!b)throw new Error('Set DISCORD_CHANNEL_ID to a registered binding')
const channel=await rest.get(Routes.channel(b.channelId))
const roles=await rest.get(Routes.guildRoles(channel.guild_id))
const member=await rest.get(Routes.guildMember(channel.guild_id,bot.id))
let permissions=roles.filter(r=>r.id===channel.guild_id || member.roles.includes(r.id)).reduce((p,r)=>p|BigInt(r.permissions),0n)
for(const overwrite of channel.permission_overwrites || [])if(overwrite.id===channel.guild_id)permissions=(permissions&~BigInt(overwrite.deny))|BigInt(overwrite.allow)
let deny=0n,allow=0n
for(const overwrite of channel.permission_overwrites || [])if(member.roles.includes(overwrite.id)){deny|=BigInt(overwrite.deny);allow|=BigInt(overwrite.allow)}
permissions=(permissions&~deny)|allow
for(const overwrite of channel.permission_overwrites || [])if(overwrite.id===bot.id)permissions=(permissions&~BigInt(overwrite.deny))|BigInt(overwrite.allow)
console.log(JSON.stringify({botPermissions:new PermissionsBitField(permissions).toArray()}))
for(const binding of [b]){
 const name=binding.channelName
 const status=await rest.get(Routes.channelMessage(binding.channelId,binding.statusId))
 console.log(JSON.stringify({channel:name,statusMessage:status.id,pinned:status.pinned,buttons:status.components.flatMap(row=>row.components).map(c=>c.label),health:binding.health}))
}
const task=state.all('task').find(t=>t.channelId===b.channelId)
const root=await rest.get(Routes.channelMessage(task.originChannelId,task.id))
const messages=await rest.get(Routes.channelMessages(task.threadId),{query:new URLSearchParams({limit:'10'})})
console.log(JSON.stringify({taskThread:task.threadId,reactions:root.reactions?.map(r=>r.emoji.name),threadMessages:messages.length,uploads:messages.filter(m=>m.attachments.length).map(m=>m.attachments.map(a=>({name:a.filename,size:a.size})))}))
state.close()
