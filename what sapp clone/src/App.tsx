import { useEffect, useState, type ReactNode } from 'react';
import {
  Bell,
  Bookmark,
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Compass,
  Heart,
  Home,
  ImagePlus,
  MapPin,
  Menu,
  MessageCircle,
  Mic,
  MoreHorizontal,
  Music2,
  Plus,
  Search,
  Send,
  Share2,
  Sparkles,
  Users,
  Video,
  X,
} from 'lucide-react';

type View = 'Feed' | 'Messages' | 'Reels';
type Post = { id: number; name: string; handle: string; place: string; time: string; text: string; image?: string; likes: number; liked: boolean; comments: number; avatar: string };
type ChatMessage = { id: number; text: string; mine: boolean; time: string };

const initialPosts: Post[] = [
  {
    id: 1,
    name: 'Mariama Sesay',
    handle: '@mariama.makes',
    place: 'Lumley, Freetown',
    time: '18 min',
    text: 'Saturday light over Lumley never misses. Freetown, you are something else. 🇸🇱',
    image: 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?auto=format&fit=crop&w=1200&q=78',
    likes: 128,
    liked: false,
    comments: 19,
    avatar: 'MS',
  },
  {
    id: 2,
    name: 'Abdul Kamara',
    handle: '@abdul.codes',
    place: 'Bo, Southern Province',
    time: '1 hr',
    text: 'Building something for home, one line at a time. Any local designers here up for a collab?',
    likes: 42,
    liked: false,
    comments: 8,
    avatar: 'AK',
  },
];

const chats = [
  { name: 'Hawa Conteh', handle: '@hawaconteh', preview: 'You have to try the cassava leaf here', time: '2m', avatar: 'HC', online: true, color: 'rose' },
  { name: 'Freetown Creatives', handle: '8 members', preview: 'Ibrahim: shared a voice note', time: '16m', avatar: 'FC', online: true, color: 'blue' },
  { name: 'Abdul Kamara', handle: '@abdul.codes', preview: 'That sounds like a plan!', time: '1h', avatar: 'AK', online: false, color: 'green' },
  { name: 'Mabel Jalloh', handle: '@mabel.j', preview: 'Photo', time: '3h', avatar: 'MJ', online: false, color: 'plum' },
];

const messageStorageKey = 'syx-messages-v1';
const postStorageKey = 'syx-posts-v1';
const savedPostStorageKey = 'syx-saved-posts-v1';
const initialMessagesByChat: Record<number, ChatMessage[]> = {
  0: [
    { id: 1, text: 'Hey! You around this weekend?', mine: false, time: '10:42' },
    { id: 2, text: 'Yes! I was thinking we could check out that new place near Lumley.', mine: true, time: '10:44' },
    { id: 3, text: 'You have to try the cassava leaf here', mine: false, time: '10:46' },
  ],
  1: [{ id: 4, text: 'Ibrahim shared a voice note from the meetup.', mine: false, time: '10:31' }],
  2: [{ id: 5, text: 'That sounds like a plan!', mine: false, time: '09:15' }],
  3: [{ id: 6, text: 'I sent you the photos from yesterday.', mine: false, time: '08:20' }],
};

function loadPosts(): Post[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(postStorageKey) || 'null');
    if (!Array.isArray(saved)) return initialPosts;
    const isPost = (post: unknown): post is Post => {
      if (!post || typeof post !== 'object') return false;
      const candidate = post as Record<string, unknown>;
      return typeof candidate.id === 'number' && typeof candidate.name === 'string'
        && typeof candidate.handle === 'string' && typeof candidate.place === 'string'
        && typeof candidate.time === 'string' && typeof candidate.text === 'string'
        && typeof candidate.likes === 'number' && typeof candidate.liked === 'boolean'
        && typeof candidate.comments === 'number' && typeof candidate.avatar === 'string'
        && (candidate.image === undefined || typeof candidate.image === 'string');
    };
    return saved.every(isPost) ? saved : initialPosts;
  } catch {
    return initialPosts;
  }
}

function loadSavedPostIds(): number[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(savedPostStorageKey) || '[]');
    return Array.isArray(saved) && saved.every((id) => typeof id === 'number') ? saved : [];
  } catch {
    return [];
  }
}

function loadMessagesByChat(): Record<number, ChatMessage[]> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(messageStorageKey) || 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return initialMessagesByChat;
    const entries = Object.entries(saved);
    const isMessageList = (value: unknown): value is ChatMessage[] => Array.isArray(value) && value.every((message) => {
      if (!message || typeof message !== 'object') return false;
      const candidate = message as Record<string, unknown>;
      return typeof candidate.id === 'number' && typeof candidate.text === 'string' && typeof candidate.mine === 'boolean' && typeof candidate.time === 'string';
    });
    if (entries.some(([, messages]) => !isMessageList(messages))) return initialMessagesByChat;
    return Object.fromEntries(entries) as Record<number, ChatMessage[]>;
  } catch {
    return initialMessagesByChat;
  }
}

const reelItems = [
  { title: 'Morning at the Cotton Tree', creator: 'Fatmata K.', place: 'Freetown', audio: 'Original audio · Fatmata K.', image: 'https://images.unsplash.com/photo-1516026672322-bc52d61a55d5?auto=format&fit=crop&w=900&q=80', video: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', likes: '2.4k' },
  { title: 'Market colours in Kenema', creator: 'Sierra Lens', place: 'Kenema', audio: 'Sweet Salone · Instrumental', image: 'https://images.unsplash.com/photo-1531058020387-3be344556be6?auto=format&fit=crop&w=900&q=80', video: 'https://www.w3schools.com/html/mov_bbb.mp4', likes: '986' },
  { title: 'Evening by the water', creator: 'Amie J.', place: 'Lumley Beach', audio: 'Original audio · Amie J.', image: 'https://images.unsplash.com/photo-1500375592092-40eb2168fd21?auto=format&fit=crop&w=900&q=80', video: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm', likes: '4.1k' },
];

function FlagMark() {
  return <span className="flag-mark" aria-label="Sierra Leone flag"><i /><i /><i /></span>;
}

function Avatar({ label, color = 'gold', small = false }: { label: string; color?: string; small?: boolean }) {
  return <span className={`avatar avatar-${color}${small ? ' avatar-small' : ''}`}>{label}</span>;
}

function App() {
  const [view, setView] = useState<View>('Feed');
  const [posts, setPosts] = useState<Post[]>(loadPosts);
  const [savedPostIds, setSavedPostIds] = useState<number[]>(loadSavedPostIds);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [showSavedPosts, setShowSavedPosts] = useState(false);
  const [activeChat, setActiveChat] = useState(0);
  const [chatSearch, setChatSearch] = useState('');
  const [messageDraft, setMessageDraft] = useState('');
  const [messagesByChat, setMessagesByChat] = useState<Record<number, ChatMessage[]>>(loadMessagesByChat);
  const [reelIndex, setReelIndex] = useState(0);
  const [touchStartY, setTouchStartY] = useState<number | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(messageStorageKey, JSON.stringify(messagesByChat));
    } catch {
      setNotice('Browser storage is unavailable. Messages will not persist after reload.');
    }
  }, [messagesByChat]);

  useEffect(() => {
    try {
      localStorage.setItem(postStorageKey, JSON.stringify(posts));
    } catch {
      setNotice('Browser storage is unavailable. Posts will not persist after reload.');
    }
  }, [posts]);

  useEffect(() => {
    try {
      localStorage.setItem(savedPostStorageKey, JSON.stringify(savedPostIds));
    } catch {
      setNotice('Browser storage is unavailable. Saved posts will not persist after reload.');
    }
  }, [savedPostIds]);

  const selectView = (next: View) => {
    setView(next);
    setMobileMenuOpen(false);
  };

  const publishPost = () => {
    const text = draft.trim();
    if (!text) return;
    setPosts((current) => [{ id: Date.now(), name: 'Ramatu Koroma', handle: '@ramatu.k', place: 'Freetown', time: 'now', text, likes: 0, liked: false, comments: 0, avatar: 'RK' }, ...current]);
    setDraft('');
    setNotice('Your update is on the feed.');
    window.setTimeout(() => setNotice(''), 2400);
  };

  const toggleLike = (id: number) => {
    setPosts((current) => current.map((post) => post.id === id ? { ...post, liked: !post.liked, likes: post.likes + (post.liked ? -1 : 1) } : post));
  };

  const toggleSavedPost = (id: number) => {
    setSavedPostIds((current) => current.includes(id) ? current.filter((savedId) => savedId !== id) : [...current, id]);
  };

  const sendMessage = () => {
    const text = messageDraft.trim();
    if (!text) return;
    const message = { id: Date.now(), text, mine: true, time: new Date().toLocaleTimeString('en-SL', { hour: '2-digit', minute: '2-digit' }) };
    setMessagesByChat((current) => ({ ...current, [activeChat]: [...(current[activeChat] ?? []), message] }));
    setMessageDraft('');
  };

  const moveReel = (step: number) => setReelIndex((reelIndex + step + reelItems.length) % reelItems.length);
  const currentReel = reelItems[reelIndex];
  const visibleChats = chats
    .map((chat, index) => ({ chat, index }))
    .filter(({ chat }) => `${chat.name} ${chat.handle}`.toLowerCase().includes(chatSearch.trim().toLowerCase()));
  const visiblePosts = posts.filter((post) => {
    const matchesSearch = `${post.name} ${post.handle} ${post.place} ${post.text}`.toLowerCase().includes(search.trim().toLowerCase());
    return matchesSearch && (!showSavedPosts || savedPostIds.includes(post.id));
  });

  return (
    <div className="app-shell">
      <aside className={`sidebar${mobileMenuOpen ? ' sidebar-open' : ''}`}>
        <a className="brand" href="#home" onClick={() => selectView('Feed')} aria-label="SYX home">
          <span className="brand-mark">S<span>Y</span>X</span>
          <span className="brand-sub">SALONE, IN SYNC</span>
        </a>
        <div className="sidebar-section-label">YOUR SPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          <NavButton icon={<Home />} label="Feed" active={view === 'Feed'} onClick={() => selectView('Feed')} />
          <NavButton icon={<MessageCircle />} label="Messages" active={view === 'Messages'} badge="2" onClick={() => selectView('Messages')} />
          <NavButton icon={<Video />} label="Reels" active={view === 'Reels'} onClick={() => selectView('Reels')} />
        </nav>

        <div className="sidebar-section-label discover-label">DISCOVER</div>
        <nav className="primary-nav" aria-label="Explore">
          <NavButton icon={<Compass />} label="Explore" onClick={() => setNotice('Explore is coming in the next build.')} />
          <NavButton icon={<Users />} label="Communities" onClick={() => setNotice('Communities are coming in the next build.')} />
          <NavButton icon={<Bookmark />} label="Saved" active={view === 'Feed' && showSavedPosts} onClick={() => { setShowSavedPosts(true); selectView('Feed'); }} />
        </nav>

        <div className="sidebar-trending">
          <div className="sidebar-section-label">ON THE GROUND</div>
          <div className="trend-row"><span className="trend-number">01</span><div><strong>#SaloneTech</strong><small>1.2k conversations</small></div></div>
          <div className="trend-row"><span className="trend-number">02</span><div><strong>#FreetownEats</strong><small>834 conversations</small></div></div>
          <div className="trend-row"><span className="trend-number">03</span><div><strong>#MadeInSalone</strong><small>621 conversations</small></div></div>
        </div>

        <button className="profile-switch" onClick={() => setNotice('Profile settings are coming soon.')}>
          <Avatar label="RK" small />
          <span className="profile-copy"><strong>Ramatu Koroma</strong><small>@ramatu.k</small></span>
          <MoreHorizontal size={18} />
        </button>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}>
            {mobileMenuOpen ? <X /> : <Menu />}
          </button>
          <div className="mobile-brand"><span className="brand-mark">S<span>Y</span>X</span><FlagMark /></div>
          <div className="search-box"><Search size={17} /><input value={search} onChange={(event) => { setSearch(event.target.value); setShowSavedPosts(false); if (event.target.value) selectView('Feed'); }} placeholder="Search people, places, moments" aria-label="Search people, places, and posts" /><kbd>/</kbd></div>
          <button className="icon-button notification-button" aria-label="Notifications" onClick={() => setNotice('You are all caught up.')}><Bell /><span /></button>
          <button className="top-avatar" aria-label="Your profile" onClick={() => setNotice('Profile settings are coming soon.')}><Avatar label="RK" small /></button>
        </header>

        <div className="mobile-tabs" role="tablist" aria-label="SYX sections">
          {(['Feed', 'Messages', 'Reels'] as View[]).map((item) => <button key={item} role="tab" aria-selected={view === item} className={view === item ? 'selected' : ''} onClick={() => selectView(item)}>{item}</button>)}
        </div>

        {view === 'Feed' && <section className="content-grid">
          <div className="feed-column">
            <div className="welcome-row">
              <div><div className="eyebrow"><Sparkles size={13} /> THURSDAY, F TOWN</div><h1>Your people.<br /><span>Your place.</span></h1></div>
              <div className="welcome-stamp"><FlagMark /><strong>Western Area</strong><small>28°C · Clear skies</small></div>
            </div>

            <div className="stories-strip">
              <button className="story-item add-story" onClick={() => setNotice('Story posting is coming soon.')}><span className="story-ring add-ring"><Plus /></span><span>Your story</span></button>
              {[
                { name: 'Fatmata', label: 'FK', color: 'rose' }, { name: 'Ibrahim', label: 'IK', color: 'blue' }, { name: 'Amie', label: 'AJ', color: 'plum' }, { name: 'Sorie', label: 'SK', color: 'green' }, { name: 'Hawa', label: 'HC', color: 'amber' },
              ].map((story) => <button className="story-item" key={story.name} onClick={() => setNotice(`${story.name}'s story is not available in this prototype.`)}><span className="story-ring"><Avatar label={story.label} color={story.color} /></span><span>{story.name}</span></button>)}
            </div>

            <div className="composer panel">
              <Avatar label="RK" />
              <div className="composer-main"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="What’s happening in your corner of Salone?" rows={2} /><div className="composer-actions"><div><button className="subtle-action" onClick={() => setNotice('Photo uploads arrive with media storage setup.')}><ImagePlus /> <span>Photo</span></button><button className="subtle-action" onClick={() => setNotice('Video uploads arrive with media storage setup.')}><Video /> <span>Video</span></button><button className="subtle-action location-action" onClick={() => setNotice('Location sharing is coming soon.')}><MapPin /> <span>Place</span></button></div><button className="gold-button publish-button" onClick={publishPost} disabled={!draft.trim()}>Post <Send size={14} /></button></div></div>
            </div>

            <div className="feed-heading"><div><span className="eyebrow">{showSavedPosts ? 'YOUR COLLECTION' : 'THE COMMUNITY'}</span><h2>{showSavedPosts ? 'Saved posts' : 'Fresh from Salone'}</h2></div><button className="sort-button" onClick={() => setShowSavedPosts(!showSavedPosts)}><span>{showSavedPosts ? 'Saved' : 'Latest'}</span><ChevronDown size={15} /></button></div>

            <div className="post-list">{visiblePosts.map((post) => <article className="post-card panel" key={post.id}>
              <div className="post-head"><Avatar label={post.avatar} color={post.avatar === 'RK' ? 'gold' : undefined} /><div className="post-identity"><strong>{post.name} <span className="verified">✓</span></strong><small>{post.handle} <i>·</i> {post.time}</small></div><button className="icon-button more-button" aria-label="More post options" onClick={() => setNotice('Post options are coming soon.')}><MoreHorizontal /></button></div>
              <p className="post-copy">{post.text}</p>
              {post.image && <img className="post-image" src={post.image} alt="Coastline near Freetown" loading="lazy" />}
              <div className="post-place"><MapPin size={13} /> {post.place}</div>
              <div className="post-actions"><button className={post.liked ? 'liked' : ''} onClick={() => toggleLike(post.id)} aria-label={post.liked ? 'Unlike post' : 'Like post'}><Heart size={18} fill={post.liked ? 'currentColor' : 'none'} /> <span>{post.likes}</span></button><button onClick={() => setNotice('Comments are coming with the API stage.')}><MessageCircle size={18} /><span>{post.comments}</span></button><button onClick={() => setNotice('Share link copied locally.')}><Share2 size={17} /><span>Share</span></button><button className={savedPostIds.includes(post.id) ? 'saved' : ''} onClick={() => toggleSavedPost(post.id)} aria-label={savedPostIds.includes(post.id) ? 'Remove saved post' : 'Save post'} title={savedPostIds.includes(post.id) ? 'Remove saved post' : 'Save post'}><Bookmark size={17} fill={savedPostIds.includes(post.id) ? 'currentColor' : 'none'} /></button></div>
            </article>)}</div>
            {visiblePosts.length === 0 && <p className="empty-state">{showSavedPosts ? 'You have not saved any posts yet.' : 'No posts match your search.'}</p>}
          </div>
          <aside className="right-rail">
            <section className="salone-card"><div className="salone-card-top"><span className="eyebrow">A LITTLE CLOSER TO HOME</span><FlagMark /></div><h3>Salone is<br /><em>all of us.</em></h3><p>Good people, big ideas, and everyday moments from every corner of Sierra Leone.</p><div className="salone-stats"><div><strong>16</strong><small>districts</small></div><div><strong>1</strong><small>community</small></div><div><strong>∞</strong><small>stories</small></div></div><div className="salone-map-motif" aria-hidden="true">SL</div></section>
            <section className="rail-section"><div className="rail-heading"><h3>People to know</h3><button onClick={() => setNotice('More suggestions are coming soon.')}>See all</button></div>
              {[{ name: 'Ibrahim Kargbo', tag: 'Photographer · Freetown', avatar: 'IK', color: 'blue' }, { name: 'Zainab Bangura', tag: 'Food & culture · Bo', avatar: 'ZB', color: 'rose' }, { name: 'Sorie Turay', tag: 'Music · Makeni', avatar: 'ST', color: 'green' }].map((person) => <div className="suggestion" key={person.name}><Avatar label={person.avatar} color={person.color} /><span><strong>{person.name}</strong><small>{person.tag}</small></span><button aria-label={`Follow ${person.name}`} onClick={() => setNotice(`Follow request sent to ${person.name}.`)}><Plus size={16} /></button></div>)}
            </section>
            <footer className="rail-footer">About · Community · Privacy<br />SYX · Sierra Leone <span>© 2026</span></footer>
          </aside>
        </section>}

        {view === 'Messages' && <section className="messages-view">
          <div className="messages-heading"><div><span className="eyebrow">YOUR CONVERSATIONS</span><h1>Messages</h1></div><button className="gold-icon-button" onClick={() => setNotice('New conversation setup is coming soon.')} aria-label="New conversation"><Plus /></button></div>
          <div className="messages-panel panel"><div className="chat-list"><div className="chat-search"><Search size={16} /><input value={chatSearch} onChange={(event) => setChatSearch(event.target.value)} placeholder="Find a conversation" aria-label="Find a conversation" /></div>{visibleChats.map(({ chat, index }) => { const latest = messagesByChat[index]?.at(-1); return <button className={`chat-preview${activeChat === index ? ' chat-active' : ''}`} key={chat.name} onClick={() => setActiveChat(index)}><span className="chat-avatar-wrap"><Avatar label={chat.avatar} color={chat.color} /><i className={chat.online ? 'online-dot' : ''} /></span><span className="chat-preview-copy"><strong>{chat.name}</strong><small>{latest?.text ?? chat.preview}</small></span><span className="chat-time">{latest?.time ?? chat.time}</span></button>; })}</div>
            <div className="chat-room"><div className="chat-room-head"><Avatar label={chats[activeChat].avatar} color={chats[activeChat].color} /><span><strong>{chats[activeChat].name}</strong><small>{chats[activeChat].online ? 'Active now' : chats[activeChat].handle}</small></span><button className="icon-button" aria-label="Conversation options" onClick={() => setNotice('Conversation details are coming soon.')}><MoreHorizontal /></button></div>
              <div className="chat-date">TODAY · FREETOWN TIME</div><div className="message-stack">{(messagesByChat[activeChat] ?? []).map((message) => <div key={message.id} className={`message-line${message.mine ? ' message-mine' : ''}`}><p>{message.text}<small>{message.time}{message.mine && <span> · ✓✓</span>}</small></p></div>)}</div>
              <div className="chat-composer"><button className="icon-button" aria-label="Attach a photo" onClick={() => setNotice('Media sharing arrives with Cloudinary setup.')}><Camera /></button><input value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && sendMessage()} placeholder="Write a message…" aria-label="Write a message" /><button className="icon-button" aria-label="Record a voice note" onClick={() => setNotice('Voice notes are planned for the realtime stage.')}><Mic /></button><button className="send-message" onClick={sendMessage} aria-label="Send message"><Send size={17} /></button></div>
            </div>
          </div>
        </section>}

        {view === 'Reels' && <section className="reels-view"><div className="reels-header"><div><span className="eyebrow"><Music2 size={13} /> SYX SHORTS</span><h1>Small clips.<br /><span>Big Salone energy.</span></h1></div><button className="gold-button" onClick={() => setNotice('Video upload opens after media storage is connected.')}><Plus size={17} /> Create</button></div>
          <div className="reel-stage" tabIndex={0} onKeyDown={(event) => { if (event.key === 'ArrowDown') moveReel(1); if (event.key === 'ArrowUp') moveReel(-1); }} onTouchStart={(event) => setTouchStartY(event.changedTouches[0].clientY)} onTouchEnd={(event) => { if (touchStartY !== null && Math.abs(touchStartY - event.changedTouches[0].clientY) > 45) moveReel(touchStartY > event.changedTouches[0].clientY ? 1 : -1); setTouchStartY(null); }}><button className="reel-arrow reel-prev" aria-label="Previous Reel" onClick={() => moveReel(-1)}><ChevronLeft /></button><article className="reel-card"><video className="reel-video" autoPlay muted loop playsInline src={currentReel.video} poster={currentReel.image} /><div className="reel-topline"><span><FlagMark /> SALONE, RIGHT NOW</span><span>{String(reelIndex + 1).padStart(2, '0')} / {String(reelItems.length).padStart(2, '0')}</span></div><div className="reel-caption"><span className="reel-place"><MapPin size={13} /> {currentReel.place}</span><h2>{currentReel.title}</h2><p>@{currentReel.creator.replaceAll(' ', '').toLowerCase()}</p><span className="reel-audio"><Music2 size={14} /> {currentReel.audio}</span></div><div className="reel-actions"><button onClick={() => setNotice('You liked this Reel.')}><Heart /><span>{currentReel.likes}</span></button><button onClick={() => setNotice('Share link copied locally.')}><Share2 /><span>Share</span></button><button onClick={() => setNotice('More Reel options are coming soon.')}><MoreHorizontal /><span>More</span></button></div></article><button className="reel-arrow reel-next" aria-label="Next Reel" onClick={() => moveReel(1)}><ChevronRight /></button></div><div className="reel-hint">Swipe up, press ↑ ↓, or use the arrows</div>
        </section>}

        <nav className="bottom-nav" aria-label="Mobile navigation">
          <NavButton icon={<Home />} label="Feed" active={view === 'Feed'} onClick={() => selectView('Feed')} />
          <NavButton icon={<MessageCircle />} label="Messages" active={view === 'Messages'} onClick={() => selectView('Messages')} />
          <NavButton icon={<Video />} label="Reels" active={view === 'Reels'} onClick={() => selectView('Reels')} />
          <button className="bottom-nav-item" onClick={() => setNotice('Notifications are coming soon.')}><Bell /><span>Alerts</span></button>
        </nav>
      </main>
      {notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={14} /></button></div>}
    </div>
  );
}

function NavButton({ icon, label, active = false, badge, onClick }: { icon: ReactNode; label: string; active?: boolean; badge?: string; onClick: () => void }) {
  return <button className={`nav-item${active ? ' nav-active' : ''}`} onClick={onClick}><span className="nav-icon">{icon}</span><span>{label}</span>{badge && <span className="nav-badge">{badge}</span>}</button>;
}

export default App;
