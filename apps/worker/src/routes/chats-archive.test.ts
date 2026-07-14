// POST /api/chats/:id/archive — admin "delete conversation" = archive (MIN-266).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const NOW = '2026-07-14T12:00:00.000+09:00';

const dbMocks = {
  getOperators: vi.fn(),
  getOperatorById: vi.fn(),
  createOperator: vi.fn(),
  updateOperator: vi.fn(),
  deleteOperator: vi.fn(),
  getChats: vi.fn(),
  getChatById: vi.fn(),
  createChat: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  updateChat: vi.fn(),
  jstNow: vi.fn(() => NOW),
};
vi.mock('@line-crm/db', () => dbMocks);

const sessionMocks = {
  archiveActiveSession: vi.fn(),
  sendSystemNote: vi.fn(),
  ARCHIVE_NOTES: {
    admin_delete: 'オペレーターにより、これまでの会話履歴がアーカイブされました。',
    idle_ttl: 'idle',
    user_new: 'new',
  },
};
vi.mock('../services/chat-sessions.js', () => sessionMocks);

vi.mock('@line-crm/line-sdk', () => ({ LineClient: vi.fn(() => ({})) }));

const { chats } = await import('./chats.js');

const FRIEND = {
  id: 'friend-1',
  line_user_id: 'U1',
  line_account_id: null,
};

type TestEnv = {
  Bindings: { DB: D1Database; LINE_CHANNEL_ACCESS_TOKEN: string };
  Variables: { staff: { id: string; name: string; role: string } };
};

function setupApp(staff?: { id: string; name: string; role: string }) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = { DB: {} as D1Database, LINE_CHANNEL_ACCESS_TOKEN: 'default-token' };
    if (staff) c.set('staff', staff);
    await next();
  });
  app.route('/', chats);
  return app;
}

function archiveRequest(app: Hono<TestEnv>, id = 'friend-1') {
  return app.request(`/api/chats/${id}/archive`, { method: 'POST' });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getFriendById.mockResolvedValue(FRIEND);
  sessionMocks.archiveActiveSession.mockResolvedValue({ archivedAt: NOW });
  sessionMocks.sendSystemNote.mockResolvedValue('push');
});

describe('POST /api/chats/:id/archive', () => {
  it('archives with reason admin_delete, records the staff id, pushes note (1)', async () => {
    const app = setupApp({ id: 'staff-9', name: 'Op', role: 'admin' });
    const res = await archiveRequest(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, data: { archivedAt: NOW, noteSent: true } });

    expect(sessionMocks.archiveActiveSession).toHaveBeenCalledWith(
      expect.anything(),
      'friend-1',
      'admin_delete',
      NOW,
      'staff-9',
    );
    // No reply token exists in this flow — the note must go out as a push,
    // logged at the archive boundary so it renders inside the archived segment.
    expect(sessionMocks.sendSystemNote).toHaveBeenCalledWith(
      expect.objectContaining({
        friendId: 'friend-1',
        lineUserId: 'U1',
        text: sessionMocks.ARCHIVE_NOTES.admin_delete,
        createdAt: NOW,
      }),
    );
    expect(sessionMocks.sendSystemNote.mock.calls[0][0].replyToken).toBeUndefined();
  });

  it('resolves a chats.id to its friend', async () => {
    dbMocks.getFriendById.mockResolvedValueOnce(null).mockResolvedValueOnce(FRIEND);
    dbMocks.getChatById.mockResolvedValue({ id: 'chat-1', friend_id: 'friend-1' });
    const app = setupApp({ id: 'staff-9', name: 'Op', role: 'admin' });
    const res = await archiveRequest(app, 'chat-1');
    expect(res.status).toBe(200);
    expect(sessionMocks.archiveActiveSession).toHaveBeenCalledWith(
      expect.anything(),
      'friend-1',
      'admin_delete',
      NOW,
      'staff-9',
    );
  });

  it('404s when neither a friend nor a chat matches', async () => {
    dbMocks.getFriendById.mockResolvedValue(null);
    dbMocks.getChatById.mockResolvedValue(null);
    const res = await archiveRequest(setupApp());
    expect(res.status).toBe(404);
  });

  it('409s when there is nothing to archive', async () => {
    sessionMocks.archiveActiveSession.mockResolvedValue(null);
    const res = await archiveRequest(setupApp());
    expect(res.status).toBe(409);
  });

  it('still succeeds (noteSent=false) when the push fails — archive already happened', async () => {
    sessionMocks.sendSystemNote.mockRejectedValue(new Error('blocked'));
    const res = await archiveRequest(setupApp());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    expect(body.data).toEqual({ archivedAt: NOW, noteSent: false });
  });
});
