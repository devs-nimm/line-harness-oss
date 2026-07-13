import { getScenarios, enrollFriendInScenario, jstNow } from '@line-crm/db';
import { fireEvent } from './event-bus.js';

// friend に tag を attach し、`POST /api/friends/:id/tags` と同じ side effects を発火する。
// side effects: tag_added シナリオ enrollment + tag_change イベント (automation/webhook/scoring 用)。
//
// 新規付与のときだけ side effects を発火する (`changes` を見る)。同じ friend に同じ tag を
// 自動付与で繰り返し叩いたとき、シナリオの重複 enrollment や tag_change の重複発火を防ぐ。
//
// POST /api/friends/:id/tags は手動操作の signal として「毎クリックで発火」する設計のため、
// この helper には合流させていない (重複 enroll はチェックがあるが tag_change は冪等でない)。
// 自動経路 (予約 auto-tag 等) はここ経由で呼ぶ。
export async function attachTagAndFireSideEffects(
  db: D1Database,
  friendId: string,
  tagId: string,
): Promise<{ added: boolean }> {
  const result = await db
    .prepare(
      `INSERT INTO friend_tags (friend_id, tag_id, assigned_at)
       VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(friendId, tagId, jstNow())
    .run();
  const added = (result.meta?.changes ?? 0) > 0;
  if (!added) return { added: false };

  const scenarios = await getScenarios(db);
  for (const scenario of scenarios) {
    if (
      scenario.trigger_type === 'tag_added' &&
      scenario.is_active &&
      scenario.trigger_tag_id === tagId
    ) {
      const existing = await db
        .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
        .bind(friendId, scenario.id)
        .first();
      if (!existing) {
        await enrollFriendInScenario(db, friendId, scenario.id);
      }
    }
  }

  await fireEvent(db, 'tag_change', { friendId, eventData: { tagId, action: 'add' } });
  return { added: true };
}
