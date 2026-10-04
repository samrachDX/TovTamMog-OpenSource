import { db } from '@/lib/db';
import { actorRank, listCategories, listRoles } from '@/lib/admin/employees';
import { getProfile } from '@/lib/profile';
import { handle, json, portalActor } from '@/lib/http';

/** Who is signed in to the portal, what they may do, and the reference lists the screens need. */
export function GET(req: Request) {
  return handle(req, async () => {
    const actor = await portalActor(req);
    const [profile, categories, roles, branches] = await Promise.all([
      getProfile(db, actor.employeeId),
      listCategories(db, actor),
      listRoles(db, actor.orgId),
      // Branch names for pickers: every branch the actor holds any permission for.
      db.query<{ id: string; nameKm: string; nameEn: string; status: string }>(
        `select id, name_km as "nameKm", name_en as "nameEn", status from branches
         where org_id = $1 and ($2::uuid[] is null or id = any($2::uuid[])) order by name_en`,
        [actor.orgId, actor.grants.some((g) => g.branchId === null && g.permission !== 'attendance.clock' && g.permission !== 'request.create')
          ? null
          : [...new Set(actor.grants.map((g) => g.branchId).filter(Boolean))]],
      ),
    ]);
    return json({
      employeeId: actor.employeeId,
      profile: { employeeCode: profile.employeeCode, nameKm: profile.nameKm, nameEn: profile.nameEn, locale: profile.locale, digits: profile.digits, timezone: profile.timezone },
      grants: actor.grants,
      // The highest level this person holds organization-wide; limits the roles they can manage.
      rank: await actorRank(db, actor),
      branches,
      categories,
      roles,
    });
  });
}
