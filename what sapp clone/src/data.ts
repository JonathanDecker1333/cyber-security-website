import {
  createUserWithEmailAndPassword,
  deleteUser,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  startAt,
  endAt,
  where,
  writeBatch,
  type DocumentData,
  type QuerySnapshot,
  type Timestamp,
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes, type UploadMetadata } from 'firebase/storage';
import { auth, db, storage } from './firebase';

export type Profile = {
  uid: string;
  displayName: string;
  handle: string;
  email: string;
};

export type FeedPost = {
  id: string;
  authorId: string;
  authorName: string;
  authorHandle: string;
  text: string;
  place: string;
  imageUrl?: string;
  imagePath?: string;
  mediaType?: 'image' | 'video';
  likes: number;
  comments: number;
  createdAt?: Timestamp;
};

export type Conversation = {
  id: string;
  memberIds: string[];
  memberNames: Record<string, string>;
  lastMessage: string;
  updatedAt?: Timestamp;
};

export type ChatMessage = {
  id: string;
  senderId: string;
  text: string;
  imageUrl?: string;
  createdAt?: Timestamp;
};

export type PostComment = {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt?: Timestamp;
};

function services() {
  if (!auth || !db || !storage) throw new Error('Firebase is not configured. Add the VITE_FIREBASE values to .env.local.');
  return { auth, db, storage };
}

function profileFrom(user: User, data: DocumentData): Profile {
  return {
    uid: user.uid,
    displayName: String(data.displayName || user.displayName || 'Member'),
    handle: String(data.handle || user.email?.split('@')[0] || 'member'),
    email: user.email || '',
  };
}

export function observeAuth(callback: (user: User | null) => void) {
  return onAuthStateChanged(services().auth, callback);
}

export async function register(email: string, password: string, displayName: string, handleInput: string) {
  const { auth: client, db: database } = services();
  const handle = handleInput.trim().replace(/^@/, '').toLowerCase();
  const credential = await createUserWithEmailAndPassword(client, email.trim(), password);
  try {
    const handleRef = doc(database, 'handles', handle);
    await runTransaction(database, async (transaction) => {
      const existing = await transaction.get(handleRef);
      if (existing.exists()) throw new Error('That username is already taken.');
      transaction.set(handleRef, { uid: credential.user.uid });
      transaction.set(doc(database, 'users', credential.user.uid), {
        uid: credential.user.uid,
        displayName: displayName.trim(),
        handle,
        email: email.trim().toLowerCase(),
        createdAt: serverTimestamp(),
      });
    });
    await updateProfile(credential.user, { displayName: displayName.trim() });
    return credential.user;
  } catch (error) {
    await deleteUser(credential.user);
    throw error;
  }
}

export async function login(email: string, password: string) {
  const { auth: client } = services();
  return signInWithEmailAndPassword(client, email.trim(), password);
}

export async function logout() {
  await signOut(services().auth);
}

export async function loadProfile(user: User) {
  const { db: database } = services();
  const profileSnapshot = await getDoc(doc(database, 'users', user.uid));
  if (!profileSnapshot.exists()) throw new Error('Your profile is missing. Contact support.');
  return profileFrom(user, profileSnapshot.data());
}

function postList(snapshot: QuerySnapshot<DocumentData>) {
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as FeedPost);
}

export function subscribePosts(callback: (posts: FeedPost[]) => void, onError: (error: Error) => void) {
  const { db: database } = services();
  return onSnapshot(query(collection(database, 'posts'), orderBy('createdAt', 'desc'), limit(60)), (snapshot) => callback(postList(snapshot)), onError);
}

export function subscribeSavedPosts(uid: string, callback: (ids: Set<string>) => void) {
  const { db: database } = services();
  return onSnapshot(collection(database, 'users', uid, 'saved'), (snapshot) => callback(new Set(snapshot.docs.map((item) => item.id))));
}

async function uploadMedia(uid: string, path: string, file: File) {
  const { storage: bucket } = services();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const objectPath = `${path}/${uid}/${crypto.randomUUID()}-${safeName}`;
  const metadata: UploadMetadata = { contentType: file.type };
  const uploaded = await uploadBytes(ref(bucket, objectPath), file, metadata);
  return { path: objectPath, url: await getDownloadURL(uploaded.ref) };
}

export async function publishPost(profile: Profile, text: string, place: string, file?: File, kind: 'post' | 'reel' = 'post') {
  const { db: database } = services();
  const media = file ? await uploadMedia(profile.uid, kind === 'reel' ? 'reels' : 'posts', file) : undefined;
  await addDoc(collection(database, 'posts'), {
    authorId: profile.uid,
    authorName: profile.displayName,
    authorHandle: profile.handle,
    text: text.trim(),
    place: place.trim(),
    ...(media ? { imageUrl: media.url, imagePath: media.path, mediaType: file?.type.startsWith('video/') ? 'video' : 'image' } : {}),
    kind,
    likes: 0,
    comments: 0,
    createdAt: serverTimestamp(),
  });
}

export async function toggleLike(post: FeedPost, uid: string) {
  const { db: database } = services();
  const postRef = doc(database, 'posts', post.id);
  const likeRef = doc(database, 'posts', post.id, 'likes', uid);
  await runTransaction(database, async (transaction) => {
    const [likeSnapshot, postSnapshot] = await Promise.all([transaction.get(likeRef), transaction.get(postRef)]);
    if (!postSnapshot.exists()) throw new Error('This post no longer exists.');
    const currentLikes = Number(postSnapshot.data().likes || 0);
    if (likeSnapshot.exists()) {
      transaction.delete(likeRef);
      transaction.update(postRef, { likes: Math.max(0, currentLikes - 1) });
    } else {
      transaction.set(likeRef, { uid, createdAt: serverTimestamp() });
      transaction.update(postRef, { likes: currentLikes + 1 });
    }
  });
}

export async function toggleSaved(postId: string, uid: string, saved: boolean) {
  const { db: database } = services();
  const savedRef = doc(database, 'users', uid, 'saved', postId);
  if (saved) await import('firebase/firestore').then(({ deleteDoc }) => deleteDoc(savedRef));
  else await setDoc(savedRef, { postId, createdAt: serverTimestamp() });
}

export function subscribeComments(postId: string, callback: (comments: PostComment[]) => void) {
  const { db: database } = services();
  return onSnapshot(query(collection(database, 'posts', postId, 'comments'), orderBy('createdAt', 'asc'), limit(100)), (snapshot) => {
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as PostComment));
  });
}

export async function addComment(post: FeedPost, profile: Profile, text: string) {
  const { db: database } = services();
  const batch = writeBatch(database);
  const commentRef = doc(collection(database, 'posts', post.id, 'comments'));
  batch.set(commentRef, { authorId: profile.uid, authorName: profile.displayName, text: text.trim(), createdAt: serverTimestamp() });
  batch.update(doc(database, 'posts', post.id), { comments: (post.comments || 0) + 1 });
  await batch.commit();
}

export function searchProfiles(search: string, callback: (profiles: Profile[]) => void) {
  const { db: database } = services();
  const prefix = search.trim().replace(/^@/, '').toLowerCase();
  if (!prefix) {
    callback([]);
    return () => undefined;
  }
  return onSnapshot(query(collection(database, 'users'), orderBy('handle'), startAt(prefix), endAt(`${prefix}\uf8ff`), limit(12)), (snapshot) => {
    callback(snapshot.docs.map((item) => ({ ...item.data(), uid: item.id }) as Profile));
  });
}

export async function startConversation(profile: Profile, other: Profile) {
  const { db: database } = services();
  if (profile.uid === other.uid) throw new Error('Choose another person to start a conversation.');
  const memberIds = [profile.uid, other.uid].sort();
  const id = memberIds.join('_');
  const conversationRef = doc(database, 'conversations', id);
  const existing = await getDoc(conversationRef);
  if (!existing.exists()) {
    await setDoc(conversationRef, {
      memberIds,
      memberNames: { [profile.uid]: profile.displayName, [other.uid]: other.displayName },
      lastMessage: '',
      updatedAt: serverTimestamp(),
    });
  }
  return id;
}

export function subscribeConversations(uid: string, callback: (items: Conversation[]) => void) {
  const { db: database } = services();
  return onSnapshot(query(collection(database, 'conversations'), where('memberIds', 'array-contains', uid), limit(80)), (snapshot) => {
    const items = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Conversation);
    items.sort((first, second) => (second.updatedAt?.toMillis() || 0) - (first.updatedAt?.toMillis() || 0));
    callback(items);
  });
}

export function subscribeMessages(conversationId: string, callback: (items: ChatMessage[]) => void) {
  const { db: database } = services();
  return onSnapshot(query(collection(database, 'conversations', conversationId, 'messages'), orderBy('createdAt', 'asc'), limit(150)), (snapshot) => {
    callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as ChatMessage));
  });
}

export async function sendMessage(conversation: Conversation, profile: Profile, text: string, file?: File) {
  const { db: database } = services();
  const media = file ? await uploadMedia(profile.uid, `messages/${conversation.id}`, file) : undefined;
  const batch = writeBatch(database);
  const messageRef = doc(collection(database, 'conversations', conversation.id, 'messages'));
  batch.set(messageRef, {
    senderId: profile.uid,
    senderName: profile.displayName,
    text: text.trim(),
    ...(media ? { imageUrl: media.url, imagePath: media.path } : {}),
    createdAt: serverTimestamp(),
  });
  batch.update(doc(database, 'conversations', conversation.id), {
    lastMessage: text.trim() || (media ? 'Shared a photo' : ''),
    updatedAt: serverTimestamp(),
  });
  await batch.commit();
}

export async function followProfile(uid: string, targetUid: string, following: boolean) {
  const { db: database } = services();
  const relationship = doc(database, 'users', uid, 'following', targetUid);
  if (following) await import('firebase/firestore').then(({ deleteDoc }) => deleteDoc(relationship));
  else await setDoc(relationship, { uid: targetUid, createdAt: serverTimestamp() });
}

export function subscribeFollowing(uid: string, callback: (ids: Set<string>) => void) {
  const { db: database } = services();
  return onSnapshot(collection(database, 'users', uid, 'following'), (snapshot) => callback(new Set(snapshot.docs.map((item) => item.id))));
}