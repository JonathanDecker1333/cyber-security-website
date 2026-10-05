const state = {
  user: null,
  posts: [],
  conversations: [],
  activePartner: null,
  reels: [],
  statuses: [],
  channels: [],
  activeChannel: null,
  channelPosts: [],
  communities: [],
  activeCommunity: null,
  profilePrivacyUserIds: new Set(),
  profilePrivacyUsers: new Map(),
  removeProfilePhoto: false,
  view: 'feed',
};

const elements = {
  userName: document.getElementById('userName'),
  userHandle: document.getElementById('userHandle'),
  userAvatar: document.getElementById('userAvatar'),
  composeUserName: document.getElementById('composeUserName'),
  composeUserHandle: document.getElementById('composeUserHandle'),
  composeAvatar: document.getElementById('composeAvatar'),
  topbarUserName: document.getElementById('topbarUserName'),
  postForm: document.getElementById('postForm'),
  postInput: document.getElementById('postInput'),
  postsList: document.getElementById('postsList'),
  feedSearch: document.getElementById('feedSearch'),
  logoutButton: document.getElementById('logoutBtn'),
  statusMessage: document.getElementById('statusMessage'),
  memberSearch: document.getElementById('memberSearch'),
  memberResults: document.getElementById('memberResults'),
  conversationList: document.getElementById('conversationList'),
  chatHeader: document.getElementById('chatHeader'),
  messageList: document.getElementById('messageList'),
  messageForm: document.getElementById('messageForm'),
  messageInput: document.getElementById('messageInput'),
  reelForm: document.getElementById('reelForm'),
  videoUrl: document.getElementById('videoUrl'),
  reelCaption: document.getElementById('reelCaption'),
  reelError: document.getElementById('reelError'),
  reelsList: document.getElementById('reelsList'),
  statusForm: document.getElementById('statusForm'),
  statusText: document.getElementById('statusText'),
  statusFile: document.getElementById('statusFile'),
  statusPrivacy: document.getElementById('statusPrivacy'),
  statusPrivacyMemberSearch: document.getElementById('statusPrivacyMemberSearch'),
  statusPrivacyMembers: document.getElementById('statusPrivacyMembers'),
  statusFormError: document.getElementById('statusFormError'),
  statusList: document.getElementById('statusList'),
  startVoiceRecord: document.getElementById('startVoiceRecord'),
  stopVoiceRecord: document.getElementById('stopVoiceRecord'),
  voiceRecordStatus: document.getElementById('voiceRecordStatus'),
  channelCreateForm: document.getElementById('channelCreateForm'),
  channelName: document.getElementById('channelName'),
  channelDescription: document.getElementById('channelDescription'),
  channelList: document.getElementById('channelList'),
  channelDetail: document.getElementById('channelDetail'),
  channelDetailName: document.getElementById('channelDetailName'),
  channelDetailDescription: document.getElementById('channelDetailDescription'),
  channelDetailClose: document.getElementById('channelDetailClose'),
  channelPostForm: document.getElementById('channelPostForm'),
  channelPostInput: document.getElementById('channelPostInput'),
  channelPostList: document.getElementById('channelPostList'),
  communityCreateForm: document.getElementById('communityCreateForm'),
  communityName: document.getElementById('communityName'),
  communityDescription: document.getElementById('communityDescription'),
  communityList: document.getElementById('communityList'),
  communityDetail: document.getElementById('communityDetail'),
  communityDetailName: document.getElementById('communityDetailName'),
  communityDetailDescription: document.getElementById('communityDetailDescription'),
  communityDetailClose: document.getElementById('communityDetailClose'),
  communityMessages: document.getElementById('communityMessages'),
  communityMessageForm: document.getElementById('communityMessageForm'),
  communityMessageInput: document.getElementById('communityMessageInput'),
  callForm: document.getElementById('callForm'),
  callMode: document.getElementById('callMode'),
  callLinkBox: document.getElementById('callLinkBox'),
  callHistory: document.getElementById('callHistory'),
  clearCallHistory: document.getElementById('clearCallHistory'),
  profileForm: document.getElementById('profileForm'),
  profilePreview: document.getElementById('profilePreview'),
  profileInitials: document.getElementById('profileInitials'),
  profilePhotoInput: document.getElementById('profilePhotoInput'),
  removeProfilePhoto: document.getElementById('removeProfilePhoto'),
  profileNameInput: document.getElementById('profileNameInput'),
  profileAboutInput: document.getElementById('profileAboutInput'),
  profilePhone: document.getElementById('profilePhone'),
  phoneVerificationState: document.getElementById('phoneVerificationState'),
  profilePhotoPrivacy: document.getElementById('profilePhotoPrivacy'),
  profilePrivacySearch: document.getElementById('profilePrivacySearch'),
  profilePrivacyMembers: document.getElementById('profilePrivacyMembers'),
  profileFormError: document.getElementById('profileFormError'),
};

let messageRefreshTimer = null;
let memberSearchTimer = null;
let statusTimer = null;
let mediaRecorder = null;
let voiceChunks = [];
let communityRefreshTimer = null;
const callHistoryKey = 'syx-call-links-v1';

async function fetchJson(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || 'Request failed.');
  if (data === null) throw new Error('The server returned an invalid response.');
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function initialsFor(name) {
  return String(name || 'U').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'U';
}

function formatDate(dateString) {
  const value = new Date(String(dateString).includes('T') ? dateString : `${String(dateString).replace(' ', 'T')}Z`);
  if (Number.isNaN(value.getTime())) return '';
  return value.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function loadCallHistory() {
  try {
    const history = JSON.parse(localStorage.getItem(callHistoryKey) || '[]');
    if (!Array.isArray(history)) return [];
    return history.filter((call) => {
      if (!call || typeof call !== 'object' || !['voice', 'video'].includes(call.mode)) return false;
      try { return new URL(call.url).origin === 'https://meet.jit.si' && typeof call.createdAt === 'string'; }
      catch { return false; }
    }).slice(0, 20);
  } catch {
    return [];
  }
}

function renderCallHistory() {
  const history = loadCallHistory();
  elements.clearCallHistory.hidden = history.length === 0;
  elements.callHistory.innerHTML = history.length ? history.map((call) => `
    <article class="call-history-item">
      <span class="call-type-mark" aria-hidden="true">${call.mode === 'video' ? 'V' : 'A'}</span>
      <span class="call-history-copy"><strong>${call.mode === 'video' ? 'Video call' : 'Voice call'}</strong><small>${escapeHtml(formatDate(call.createdAt))}</small></span>
      <span class="call-history-actions"><button type="button" data-call-open="${escapeHtml(call.url)}">Join</button><button type="button" data-call-share="${escapeHtml(call.url)}">Share</button></span>
    </article>
  `).join('') : '<div class="empty-state">Your call links will appear here.</div>';
}

function showCallLink(call) {
  elements.callLinkBox.hidden = false;
  elements.callLinkBox.innerHTML = `
    <div class="call-link-heading"><strong>${call.mode === 'video' ? 'Video call link ready' : 'Voice call link ready'}</strong><small>Share this invite with one person or a group.</small></div>
    <input class="call-link-input" type="url" readonly aria-label="Call invite link" value="${escapeHtml(call.url)}" />
    <div class="call-link-actions"><button class="action-button" type="button" data-call-open="${escapeHtml(call.url)}">Join call</button><button class="call-share-button" type="button" data-call-share="${escapeHtml(call.url)}">Share link</button></div>
  `;
}

function createCallLink(event) {
  event.preventDefault();
  const mode = elements.callMode.value === 'voice' ? 'voice' : 'video';
  const room = `SYX-${crypto.randomUUID()}`;
  const options = mode === 'voice' ? '#config.startAudioOnly=true&config.prejoinPageEnabled=true' : '#config.prejoinPageEnabled=true';
  const call = { mode, url: `https://meet.jit.si/${room}${options}`, createdAt: new Date().toISOString() };
  const history = [call, ...loadCallHistory()].slice(0, 20);
  try {
    localStorage.setItem(callHistoryKey, JSON.stringify(history));
  } catch {
    showStatus('Call link created, but browser storage is unavailable.');
  }
  showCallLink(call);
  renderCallHistory();
}

async function shareCallLink(url) {
  try {
    if (navigator.share) {
      await navigator.share({ title: 'SYX call invite', text: 'Join my call', url });
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      showStatus('Call link copied.');
    } else {
      throw new Error('Sharing is not available in this browser.');
    }
  } catch (error) {
    if (error.name !== 'AbortError') showStatus(error.message || 'Could not share the call link.', true);
  }
}

function handleCallAction(event) {
  const openButton = event.target.closest('[data-call-open]');
  if (openButton) {
    window.open(openButton.dataset.callOpen, '_blank', 'noopener,noreferrer');
    return;
  }
  const shareButton = event.target.closest('[data-call-share]');
  if (shareButton) shareCallLink(shareButton.dataset.callShare);
}

function showStatus(message, isError = false) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.hidden = !message;
  elements.statusMessage.classList.toggle('error', isError);
  window.clearTimeout(statusTimer);
  if (message) statusTimer = window.setTimeout(() => { elements.statusMessage.hidden = true; }, 3500);
}

function renderUser() {
  if (!state.user) return;
  const initials = initialsFor(state.user.fullName);
  elements.userName.textContent = state.user.fullName;
  elements.userHandle.textContent = `@${state.user.username}`;
  elements.userAvatar.textContent = initials;
  elements.composeUserName.textContent = state.user.fullName;
  elements.composeUserHandle.textContent = `@${state.user.username}`;
  elements.composeAvatar.textContent = initials;
  elements.topbarUserName.textContent = state.user.fullName;
}

function renderPosts() {
  const query = elements.feedSearch.value.trim().toLowerCase();
  const posts = state.posts.filter((post) => `${post.user.fullName} ${post.user.username} ${post.content}`.toLowerCase().includes(query));
  if (!posts.length) {
    elements.postsList.innerHTML = `<div class="empty-state">${query ? 'No posts match your search.' : 'No posts yet. Share your first update with the community.'}</div>`;
    return;
  }
  elements.postsList.innerHTML = posts.map((post) => `
    <article class="post-card">
      <div class="post-header">
        <div class="avatar">${escapeHtml(initialsFor(post.user.fullName))}</div>
        <div class="post-meta"><strong>${escapeHtml(post.user.fullName)}</strong><small>@${escapeHtml(post.user.username)}</small></div>
      </div>
      <div class="post-content">${escapeHtml(post.content)}</div>
      <div class="post-time">${escapeHtml(formatDate(post.createdAt))}</div>
    </article>
  `).join('');
}

async function loadPosts() {
  try {
    state.posts = await fetchJson('/api/posts');
    renderPosts();
  } catch (error) {
    elements.postsList.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Unable to load posts.')}</div>`;
  }
}

function renderConversations() {
  if (!state.conversations.length) {
    elements.conversationList.innerHTML = '<div class="empty-state">No conversations yet. Find a member to start one.</div>';
    return;
  }
  elements.conversationList.innerHTML = state.conversations.map((conversation) => `
    <button class="conversation-item${state.activePartner?.id === conversation.id ? ' active' : ''}" data-conversation-id="${conversation.id}">
      <span class="avatar">${escapeHtml(initialsFor(conversation.fullName))}</span>
      <span class="conversation-item-copy"><strong>${escapeHtml(conversation.fullName)}</strong><small>${escapeHtml(conversation.lastMessage)}</small></span>
      ${conversation.unreadCount ? `<span class="nav-badge">${conversation.unreadCount}</span>` : ''}
    </button>
  `).join('');
}

async function loadConversations() {
  try {
    state.conversations = await fetchJson('/api/conversations');
    renderConversations();
  } catch (error) {
    elements.conversationList.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Unable to load conversations.')}</div>`;
  }
}

function renderMemberResults(users) {
  if (!users.length) {
    elements.memberResults.innerHTML = '<div class="empty-state">No members found.</div>';
    elements.memberResults.hidden = false;
    return;
  }
  elements.memberResults.innerHTML = users.map((user) => `
    <button type="button" class="member-result" data-member-id="${user.id}" data-member-name="${escapeHtml(user.fullName)}" data-member-username="${escapeHtml(user.username)}">
      <span class="avatar">${escapeHtml(initialsFor(user.fullName))}</span><span><strong>${escapeHtml(user.fullName)}</strong><small>@${escapeHtml(user.username)}</small></span>
    </button>
  `).join('');
  elements.memberResults.hidden = false;
}

async function searchMembers(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    elements.memberResults.hidden = true;
    elements.memberResults.innerHTML = '';
    return;
  }
  try {
    const users = await fetchJson(`/api/users?q=${encodeURIComponent(trimmed)}`);
    renderMemberResults(users);
  } catch (error) {
    elements.memberResults.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Member search failed.')}</div>`;
    elements.memberResults.hidden = false;
  }
}

async function openConversation(partner) {
  state.activePartner = partner;
  elements.memberResults.hidden = true;
  elements.memberSearch.value = '';
  elements.chatHeader.innerHTML = `<div class="avatar">${escapeHtml(initialsFor(partner.fullName))}</div><div class="chat-header-copy"><strong>${escapeHtml(partner.fullName)}</strong><small>@${escapeHtml(partner.username)}</small></div>`;
  elements.messageForm.hidden = false;
  await loadMessages();
  renderConversations();
  if (state.view === 'messages') {
    window.clearInterval(messageRefreshTimer);
    messageRefreshTimer = window.setInterval(loadMessages, 5000);
  }
  elements.messageInput.focus();
}

async function loadMessages() {
  if (!state.activePartner) return;
  try {
    const result = await fetchJson(`/api/conversations/${state.activePartner.id}/messages`);
    const messages = result.messages;
    elements.messageList.innerHTML = messages.length ? messages.map((message) => `
      <article class="message-bubble${message.senderId === state.user.id ? ' mine' : ''}">
        ${escapeHtml(message.content)}<time>${escapeHtml(formatDate(message.createdAt))}</time>
      </article>
    `).join('') : '<div class="empty-state">Start the conversation with a message.</div>';
    elements.messageList.scrollTop = elements.messageList.scrollHeight;
    await loadConversations();
  } catch (error) {
    elements.messageList.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Unable to load messages.')}</div>`;
  }
}

async function loadReels() {
  elements.reelsList.innerHTML = '<div class="empty-state">Loading Reels...</div>';
  try {
    state.reels = await fetchJson('/api/reels');
    renderReels();
  } catch (error) {
    elements.reelsList.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Unable to load Reels.')}</div>`;
  }
}

async function loadChannels() {
  try {
    state.channels = await fetchJson('/api/channels');
    elements.channelList.innerHTML = state.channels.length ? state.channels.map((channel) => `
      <article class="directory-card" data-channel-card="${channel.id}">
        <h2>${escapeHtml(channel.name)}</h2><p>${escapeHtml(channel.description || 'No description yet.')}</p>
        <div class="directory-meta"><span>@${escapeHtml(channel.ownerUsername)} · ${channel.followerCount} followers</span><span class="directory-actions">
          ${channel.following ? `<button type="button" class="secondary" data-channel-open="${channel.id}">Open</button>` : ''}
          ${channel.ownerId === state.user.id ? '<span>Owner</span>' : `<button type="button" data-channel-follow="${channel.id}">${channel.following ? 'Unfollow' : 'Follow'}</button>`}
        </span></div>
      </article>
    `).join('') : '<div class="empty-state">No Channels yet. Create one for your organization or community.</div>';
  } catch (error) {
    elements.channelList.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Unable to load Channels.')}</div>`;
  }
}

async function openChannel(channel) {
  state.activeChannel = channel;
  elements.channelDetailName.textContent = channel.name;
  elements.channelDetailDescription.textContent = channel.description;
  elements.channelDetail.hidden = false;
  elements.channelPostForm.hidden = channel.ownerId !== state.user.id;
  await loadChannelPosts();
  elements.channelDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadChannelPosts() {
  if (!state.activeChannel) return;
  try {
    state.channelPosts = await fetchJson(`/api/channels/${state.activeChannel.id}/posts`);
    elements.channelPostList.innerHTML = state.channelPosts.length ? state.channelPosts.map((post) => `
      <article class="channel-post">${escapeHtml(post.content)}<small>${escapeHtml(post.authorName)} · ${escapeHtml(formatDate(post.createdAt))}</small></article>
    `).join('') : '<div class="empty-state">No broadcasts in this Channel yet.</div>';
  } catch (error) {
    elements.channelPostList.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Unable to load Channel updates.')}</div>`;
  }
}

async function loadCommunities() {
  try {
    state.communities = await fetchJson('/api/communities');
    elements.communityList.innerHTML = state.communities.length ? state.communities.map((community) => `
      <article class="directory-card" data-community-card="${community.id}">
        <h2>${escapeHtml(community.name)}</h2><p>${escapeHtml(community.description || 'No description yet.')}</p>
        <div class="directory-meta"><span>${community.memberCount} members · by ${escapeHtml(community.ownerName)}</span><span class="directory-actions">
          ${community.joined ? `<button type="button" class="secondary" data-community-chat="${community.id}">Open chat</button>` : ''}
          <button type="button" data-community-membership="${community.id}" data-join="${!community.joined}">${community.joined ? 'Leave' : 'Join'}</button>
        </span></div>
      </article>
    `).join('') : '<div class="empty-state">No Communities yet. Create a group for your school, neighborhood, or workplace.</div>';
  } catch (error) {
    elements.communityList.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Unable to load Communities.')}</div>`;
  }
}

async function openCommunity(community) {
  state.activeCommunity = community;
  elements.communityDetailName.textContent = community.name;
  elements.communityDetailDescription.textContent = community.description;
  elements.communityDetail.hidden = false;
  await loadCommunityMessages();
  window.clearInterval(communityRefreshTimer);
  communityRefreshTimer = window.setInterval(() => {
    if (state.view === 'communities' && state.activeCommunity) loadCommunityMessages();
  }, 5000);
  elements.communityDetail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadCommunityMessages() {
  if (!state.activeCommunity) return;
  try {
    const messages = await fetchJson(`/api/communities/${state.activeCommunity.id}/messages`);
    elements.communityMessages.innerHTML = messages.length ? messages.map((message) => `
      <article class="community-message">${escapeHtml(message.content)}<small>${escapeHtml(message.senderName)} · @${escapeHtml(message.senderUsername)} · ${escapeHtml(formatDate(message.createdAt))}</small></article>
    `).join('') : '<div class="empty-state">No messages yet. Start the group conversation.</div>';
    elements.communityMessages.scrollTop = elements.communityMessages.scrollHeight;
  } catch (error) {
    elements.communityMessages.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Unable to load Community chat.')}</div>`;
  }
}

function renderStatuses() {
  if (!state.statuses.length) {
    elements.statusList.innerHTML = '<div class="empty-state updates-empty">No active Updates from your contacts yet.</div>';
    return;
  }
  elements.statusList.innerHTML = state.statuses.map((status) => {
    let media = '';
    if (status.mediaUrl && status.mediaType.startsWith('image/')) {
      media = `<img class="status-media" src="${escapeHtml(status.mediaUrl)}" alt="Status photo" loading="lazy" />`;
    } else if (status.mediaUrl && status.mediaType.startsWith('video/')) {
      media = `<video class="status-media" controls playsinline preload="metadata" src="${escapeHtml(status.mediaUrl)}"></video>`;
    } else if (status.mediaUrl && status.mediaType.startsWith('audio/')) {
      media = `<audio class="status-media" controls preload="metadata" src="${escapeHtml(status.mediaUrl)}"></audio>`;
    }
    return `
      <article class="status-card">
        <header><div class="status-author"><span class="avatar">${escapeHtml(initialsFor(status.fullName))}</span><span><strong>${escapeHtml(status.fullName)}</strong><small>@${escapeHtml(status.username)}</small></span></div><span class="status-expiry">Expires ${escapeHtml(formatDate(status.expiresAt))}</span></header>
        ${status.content ? `<p class="status-copy">${escapeHtml(status.content)}</p>` : ''}
        ${media}
      </article>
    `;
  }).join('');
}

async function loadStatuses() {
  try {
    state.statuses = await fetchJson('/api/statuses');
    renderStatuses();
  } catch (error) {
    elements.statusList.innerHTML = `<div class="empty-state updates-empty">${escapeHtml(error.message || 'Unable to load Updates.')}</div>`;
  }
}

async function loadProfileSettings() {
  elements.profileFormError.textContent = '';
  try {
    const profile = await fetchJson('/api/profile');
    state.user = profile;
    renderUser();
    elements.profileNameInput.value = profile.fullName || '';
    elements.profileAboutInput.value = profile.about || '';
    elements.profilePhone.textContent = profile.phone || 'No phone number added';
    elements.phoneVerificationState.textContent = profile.phone
      ? profile.phoneVerified ? 'Verified' : 'Not verified by SMS'
      : 'Add and verify a phone number to use phone sign-in.';
    elements.profilePhotoPrivacy.value = profile.profilePhotoPrivacy || 'all';
    state.profilePrivacyUserIds = new Set((profile.profilePhotoPrivacyUserIds || []).map(String));
    state.profilePrivacyUsers = new Map((profile.profilePhotoPrivacyUsers || []).map((user) => [String(user.id), user]));
    elements.profileInitials.textContent = initialsFor(profile.fullName);
    elements.profilePreview.hidden = !profile.hasProfilePhoto;
    elements.profilePreview.src = profile.hasProfilePhoto ? `/api/users/${profile.id}/photo?version=${Date.now()}` : '';
    elements.removeProfilePhoto.hidden = !profile.hasProfilePhoto;
    configureProfilePrivacy();
    renderProfilePrivacyUsers();
  } catch (error) {
    elements.profileFormError.textContent = error.message || 'Unable to load profile settings.';
  }
}

function configureProfilePrivacy() {
  const needsMembers = elements.profilePhotoPrivacy.value !== 'all';
  elements.profilePrivacySearch.hidden = !needsMembers;
  elements.profilePrivacyMembers.hidden = !needsMembers || state.profilePrivacyUsers.size === 0;
  renderProfilePrivacyUsers();
}

function renderProfilePrivacyUsers() {
  const members = [...state.profilePrivacyUsers.entries()];
  elements.profilePrivacyMembers.innerHTML = members.map(([id, user]) => `
    <option value="${escapeHtml(id)}"${state.profilePrivacyUserIds.has(id) ? ' selected' : ''}>${escapeHtml(user.fullName)} (@${escapeHtml(user.username)})</option>
  `).join('');
  elements.profilePrivacyMembers.hidden = elements.profilePhotoPrivacy.value === 'all' || !members.length;
}

async function searchProfilePrivacyMembers(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    renderProfilePrivacyUsers();
    return;
  }
  try {
    const users = await fetchJson(`/api/users?q=${encodeURIComponent(trimmed)}`);
    users.forEach((user) => state.profilePrivacyUsers.set(String(user.id), user));
    renderProfilePrivacyUsers();
  } catch (error) {
    elements.profileFormError.textContent = error.message || 'Member search failed.';
  }
}

async function saveProfile(event) {
  event.preventDefault();
  elements.profileFormError.textContent = '';
  const file = elements.profilePhotoInput.files[0];
  if (file && file.size > 2 * 1024 * 1024) {
    elements.profileFormError.textContent = 'Profile photos must be 2 MB or smaller.';
    return;
  }
  try {
    const payload = {
      fullName: elements.profileNameInput.value.trim(),
      about: elements.profileAboutInput.value.trim(),
      profilePhotoPrivacy: elements.profilePhotoPrivacy.value,
      profilePhotoPrivacyUserIds: [...state.profilePrivacyUserIds].map(Number),
    };
    if (file) payload.profilePhoto = await readFileAsDataUrl(file);
    else if (state.removeProfilePhoto) payload.profilePhoto = null;
    state.user = await fetchJson('/api/profile', { method: 'PATCH', body: JSON.stringify(payload) });
    renderUser();
    elements.profilePhotoInput.value = '';
    state.removeProfilePhoto = false;
    showStatus('Profile saved.');
    await loadProfileSettings();
  } catch (error) {
    elements.profileFormError.textContent = error.message || 'Could not save your profile.';
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(new Error('Could not read that media file.')));
    reader.readAsDataURL(file);
  });
}

async function findStatusPrivacyMembers(query) {
  const trimmed = query.trim();
  if (!trimmed) {
    elements.statusPrivacyMembers.innerHTML = '';
    elements.statusPrivacyMembers.hidden = true;
    return;
  }
  try {
    const users = await fetchJson(`/api/users?q=${encodeURIComponent(trimmed)}`);
    const selectedIds = new Set(Array.from(elements.statusPrivacyMembers.selectedOptions, (option) => option.value));
    elements.statusPrivacyMembers.innerHTML = users.map((user) => `<option value="${user.id}"${selectedIds.has(String(user.id)) ? ' selected' : ''}>${escapeHtml(user.fullName)} (@${escapeHtml(user.username)})</option>`).join('');
    elements.statusPrivacyMembers.hidden = false;
  } catch (error) {
    elements.statusFormError.textContent = error.message || 'Member search failed.';
  }
}

function configureStatusPrivacy() {
  const needsMembers = elements.statusPrivacy.value !== 'all';
  elements.statusPrivacyMemberSearch.hidden = !needsMembers;
  if (!needsMembers) {
    elements.statusPrivacyMemberSearch.value = '';
    elements.statusPrivacyMembers.innerHTML = '';
    elements.statusPrivacyMembers.hidden = true;
  }
}

async function submitStatus(event) {
  event.preventDefault();
  elements.statusFormError.textContent = '';
  const content = elements.statusText.value.trim();
  const file = elements.statusFile.files[0];
  if (!content && !file) {
    elements.statusFormError.textContent = 'Write an update or choose a media file.';
    return;
  }
  if (file && file.size > 8 * 1024 * 1024) {
    elements.statusFormError.textContent = 'Status media must be 8 MB or smaller.';
    return;
  }
  const selectedMembers = Array.from(elements.statusPrivacyMembers.selectedOptions, (option) => Number(option.value));
  if (elements.statusPrivacy.value !== 'all' && !selectedMembers.length) {
    elements.statusFormError.textContent = 'Select at least one member for this privacy option.';
    return;
  }

  try {
    const mediaData = file ? await readFileAsDataUrl(file) : '';
    const status = await fetchJson('/api/statuses', {
      method: 'POST',
      body: JSON.stringify({
        content,
        mediaData,
        mediaType: file?.type || '',
        privacyMode: elements.statusPrivacy.value,
        privacyUserIds: selectedMembers,
      }),
    });
    state.statuses.unshift(status);
    renderStatuses();
    elements.statusForm.reset();
    configureStatusPrivacy();
    elements.voiceRecordStatus.textContent = '';
    showStatus('Update shared. It will disappear after 24 hours.');
  } catch (error) {
    elements.statusFormError.textContent = error.message || 'Could not share this update.';
  }
}

async function startVoiceRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    elements.voiceRecordStatus.textContent = 'Voice recording is not supported in this browser.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg'].find((type) => MediaRecorder.isTypeSupported(type));
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    voiceChunks = [];
    mediaRecorder.addEventListener('dataavailable', (event) => { if (event.data.size) voiceChunks.push(event.data); });
    mediaRecorder.addEventListener('stop', () => {
      const blob = new Blob(voiceChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      const extension = blob.type.includes('ogg') ? 'ogg' : 'webm';
      const file = new File([blob], `status-voice-note.${extension}`, { type: blob.type });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      elements.statusFile.files = transfer.files;
      elements.voiceRecordStatus.textContent = 'Voice note ready to share.';
      stream.getTracks().forEach((track) => track.stop());
      mediaRecorder = null;
    });
    mediaRecorder.start();
    elements.startVoiceRecord.disabled = true;
    elements.stopVoiceRecord.disabled = false;
    elements.voiceRecordStatus.textContent = 'Recording voice note...';
  } catch {
    elements.voiceRecordStatus.textContent = 'Allow microphone access to record a voice note.';
  }
}

function stopVoiceRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  mediaRecorder.stop();
  elements.startVoiceRecord.disabled = false;
  elements.stopVoiceRecord.disabled = true;
}

function renderReels() {
  if (!state.reels.length) {
    elements.reelsList.innerHTML = '<div class="empty-state">No Reels yet. Share a direct video URL to post the first one.</div>';
    return;
  }
  elements.reelsList.innerHTML = state.reels.map((reel) => `
    <article class="reel-card" data-reel-card="${reel.id}">
      <video controls playsinline preload="metadata" referrerpolicy="no-referrer" src="${escapeHtml(reel.videoUrl)}"></video>
      <div class="reel-info"><strong>${escapeHtml(reel.fullName)} <small>@${escapeHtml(reel.username)}</small></strong>
        ${reel.caption ? `<p class="reel-caption">${escapeHtml(reel.caption)}</p>` : ''}
        <small>${escapeHtml(formatDate(reel.createdAt))}</small>
        <div><button class="reel-like${reel.liked ? ' liked' : ''}" type="button" data-reel-like="${reel.id}" aria-pressed="${Boolean(reel.liked)}">♥ <span>${reel.likeCount}</span></button></div>
      </div>
    </article>
  `).join('');
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('nav-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.getElementById('feedView').hidden = view !== 'feed';
  document.getElementById('updatesView').hidden = view !== 'updates';
  document.getElementById('settingsView').hidden = view !== 'settings';
  document.getElementById('channelsView').hidden = view !== 'channels';
  document.getElementById('communitiesView').hidden = view !== 'communities';
  document.getElementById('messagesView').hidden = view !== 'messages';
  document.getElementById('callsView').hidden = view !== 'calls';
  document.getElementById('reelsView').hidden = view !== 'reels';
  elements.feedSearch.closest('.search-box').hidden = view !== 'feed';
  window.clearInterval(messageRefreshTimer);
  window.clearInterval(communityRefreshTimer);

  if (view === 'messages') {
    loadConversations();
    if (state.activePartner) {
      loadMessages();
      messageRefreshTimer = window.setInterval(loadMessages, 5000);
    }
  } else if (view === 'reels') {
    loadReels();
  } else if (view === 'updates') {
    loadStatuses();
  } else if (view === 'channels') {
    loadChannels();
  } else if (view === 'communities') {
    loadCommunities();
  } else if (view === 'calls') {
    renderCallHistory();
  } else if (view === 'settings') {
    loadProfileSettings();
  }
}

elements.postForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = elements.postInput.value.trim();
  if (!content) return;
  try {
    const post = await fetchJson('/api/posts', { method: 'POST', body: JSON.stringify({ content }) });
    state.posts.unshift(post);
    elements.postInput.value = '';
    renderPosts();
    showStatus('Your update is on the feed.');
  } catch (error) {
    showStatus(error.message || 'Unable to post.', true);
  }
});

elements.feedSearch.addEventListener('input', renderPosts);
elements.statusForm.addEventListener('submit', submitStatus);
elements.statusPrivacy.addEventListener('change', configureStatusPrivacy);
elements.statusPrivacyMemberSearch.addEventListener('input', () => {
  window.clearTimeout(memberSearchTimer);
  memberSearchTimer = window.setTimeout(() => findStatusPrivacyMembers(elements.statusPrivacyMemberSearch.value), 180);
});
elements.startVoiceRecord.addEventListener('click', startVoiceRecording);
elements.stopVoiceRecord.addEventListener('click', stopVoiceRecording);
elements.profileForm.addEventListener('submit', saveProfile);
elements.profilePhotoPrivacy.addEventListener('change', configureProfilePrivacy);
elements.profilePrivacySearch.addEventListener('input', () => {
  window.clearTimeout(memberSearchTimer);
  memberSearchTimer = window.setTimeout(() => searchProfilePrivacyMembers(elements.profilePrivacySearch.value), 180);
});
elements.profilePrivacyMembers.addEventListener('change', () => {
  for (const option of elements.profilePrivacyMembers.options) {
    if (option.selected) state.profilePrivacyUserIds.add(option.value);
    else state.profilePrivacyUserIds.delete(option.value);
  }
});
elements.profilePhotoInput.addEventListener('change', () => {
  const file = elements.profilePhotoInput.files[0];
  state.removeProfilePhoto = false;
  if (!file) return;
  elements.profilePreview.src = URL.createObjectURL(file);
  elements.profilePreview.hidden = false;
  elements.removeProfilePhoto.hidden = false;
});
elements.removeProfilePhoto.addEventListener('click', () => {
  elements.profilePhotoInput.value = '';
  state.removeProfilePhoto = true;
  elements.profilePreview.removeAttribute('src');
  elements.profilePreview.hidden = true;
  elements.removeProfilePhoto.hidden = true;
});
elements.memberSearch.addEventListener('input', () => {
  window.clearTimeout(memberSearchTimer);
  memberSearchTimer = window.setTimeout(() => searchMembers(elements.memberSearch.value), 180);
});

elements.memberResults.addEventListener('click', (event) => {
  const button = event.target.closest('[data-member-id]');
  if (!button) return;
  openConversation({
    id: Number(button.dataset.memberId),
    fullName: button.dataset.memberName,
    username: button.dataset.memberUsername,
  });
});

elements.conversationList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-conversation-id]');
  if (!button) return;
  const partner = state.conversations.find((conversation) => conversation.id === Number(button.dataset.conversationId));
  if (partner) openConversation(partner);
});

elements.messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = elements.messageInput.value.trim();
  if (!content || !state.activePartner) return;
  try {
    await fetchJson('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ recipientId: state.activePartner.id, content }),
    });
    elements.messageInput.value = '';
    await loadMessages();
  } catch (error) {
    showStatus(error.message || 'Unable to send message.', true);
  }
});

elements.reelForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.reelError.textContent = '';
  try {
    const reel = await fetchJson('/api/reels', {
      method: 'POST',
      body: JSON.stringify({ videoUrl: elements.videoUrl.value.trim(), caption: elements.reelCaption.value.trim() }),
    });
    state.reels.unshift(reel);
    elements.reelForm.reset();
    renderReels();
    showStatus('Reel published.');
  } catch (error) {
    elements.reelError.textContent = error.message || 'Unable to publish Reel.';
  }
});

elements.reelsList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-reel-like]');
  if (!button) return;
  try {
    const result = await fetchJson(`/api/reels/${button.dataset.reelLike}/like`, { method: 'POST', body: '{}' });
    const reel = state.reels.find((item) => item.id === Number(button.dataset.reelLike));
    if (reel) {
      reel.liked = result.liked;
      reel.likeCount = result.likeCount;
      renderReels();
    }
  } catch (error) {
    showStatus(error.message || 'Unable to update Reel reaction.', true);
  }
});

elements.channelCreateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const channel = await fetchJson('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: elements.channelName.value, description: elements.channelDescription.value }),
    });
    elements.channelCreateForm.reset();
    await loadChannels();
    await openChannel(channel);
    showStatus('Channel created. You can publish its first update.');
  } catch (error) {
    showStatus(error.message || 'Could not create Channel.', true);
  }
});

elements.channelList.addEventListener('click', async (event) => {
  const followButton = event.target.closest('[data-channel-follow]');
  if (followButton) {
    try {
      await fetchJson(`/api/channels/${followButton.dataset.channelFollow}/follow`, { method: 'POST', body: '{}' });
      await loadChannels();
    } catch (error) {
      showStatus(error.message || 'Could not update Channel follow.', true);
    }
    return;
  }
  const openButton = event.target.closest('[data-channel-open]');
  if (openButton) {
    const channel = state.channels.find((item) => item.id === Number(openButton.dataset.channelOpen));
    if (channel) openChannel(channel);
  }
});

elements.channelPostForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeChannel) return;
  try {
    await fetchJson(`/api/channels/${state.activeChannel.id}/posts`, {
      method: 'POST',
      body: JSON.stringify({ content: elements.channelPostInput.value }),
    });
    elements.channelPostInput.value = '';
    await loadChannelPosts();
  } catch (error) {
    showStatus(error.message || 'Could not publish Channel update.', true);
  }
});

elements.channelDetailClose.addEventListener('click', () => {
  state.activeChannel = null;
  elements.channelDetail.hidden = true;
});

elements.communityCreateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const community = await fetchJson('/api/communities', {
      method: 'POST',
      body: JSON.stringify({ name: elements.communityName.value, description: elements.communityDescription.value }),
    });
    elements.communityCreateForm.reset();
    await loadCommunities();
    await openCommunity(community);
    showStatus('Community created. Invite members to join the group.');
  } catch (error) {
    showStatus(error.message || 'Could not create Community.', true);
  }
});

elements.communityList.addEventListener('click', async (event) => {
  const membershipButton = event.target.closest('[data-community-membership]');
  if (membershipButton) {
    const join = membershipButton.dataset.join === 'true';
    try {
      await fetchJson(`/api/communities/${membershipButton.dataset.communityMembership}/membership`, {
        method: 'POST',
        body: JSON.stringify({ join }),
      });
      await loadCommunities();
    } catch (error) {
      showStatus(error.message || 'Could not update Community membership.', true);
    }
    return;
  }
  const chatButton = event.target.closest('[data-community-chat]');
  if (chatButton) {
    const community = state.communities.find((item) => item.id === Number(chatButton.dataset.communityChat));
    if (community) openCommunity(community);
  }
});

elements.communityMessageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeCommunity) return;
  try {
    await fetchJson(`/api/communities/${state.activeCommunity.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: elements.communityMessageInput.value }),
    });
    elements.communityMessageInput.value = '';
    await loadCommunityMessages();
  } catch (error) {
    showStatus(error.message || 'Could not send Community message.', true);
  }
});

elements.communityDetailClose.addEventListener('click', () => {
  state.activeCommunity = null;
  window.clearInterval(communityRefreshTimer);
  elements.communityDetail.hidden = true;
});

elements.callForm.addEventListener('submit', createCallLink);
elements.callHistory.addEventListener('click', handleCallAction);
elements.callLinkBox.addEventListener('click', handleCallAction);
elements.clearCallHistory.addEventListener('click', () => {
  localStorage.removeItem(callHistoryKey);
  elements.callLinkBox.hidden = true;
  renderCallHistory();
});

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view));
});

elements.logoutButton.addEventListener('click', async () => {
  try {
    await fetchJson('/api/logout', { method: 'POST' });
  } finally {
    window.location.href = '/login.html';
  }
});

async function initialize() {
  try {
    const user = await fetchJson('/api/me');
    state.user = user.user || user;
    renderUser();
    await loadPosts();
  } catch {
    window.location.href = '/login.html';
  }
}

initialize();
