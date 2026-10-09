/**
 * Team and profile on the embedded self-hosted issuer (sign-in plan B1), through the Better Auth
 * client. The workspace's organization lists members and pending invitations; owners and admins
 * invite, change roles and remove, and the server applies each change to Sanctum's membership
 * (server/src/issuer-orgs.ts). No mail transport exists, so the inviter copies the invitation link.
 */
import type { AccessScope } from '@sanctum/sdk';
import { type FormEvent, type SelectHTMLAttributes, useCallback, useEffect, useState } from 'react';
import { SIGN_IN_URL } from '../../lib/session.ts';
import { Dialog } from '../listen/Dialog.tsx';
import { auth } from './index.tsx';

type Role = 'member' | 'admin' | 'owner';
type Member = typeof auth.$Infer.Member;
type Invitation = typeof auth.$Infer.Invitation;
type Result = { readonly error: { readonly message?: string | undefined } | null };
type Change = (action: () => Promise<Result>) => void;

const ROLES: ReadonlyArray<Role> = ['member', 'admin', 'owner'];
const INVITABLE = ROLES.filter(role => role !== 'owner');
const field = 'min-w-0 rounded border border-divider bg-surface px-3 py-2 text-ink outline-none focus-visible:border-accent';
const row = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5';
const inviteLink = (id: string) => `${location.origin}/invite/${id}`;

interface Team { readonly me: string; readonly members: ReadonlyArray<Member>; readonly invitations: ReadonlyArray<Invitation> }
type View = { readonly kind: 'loading' | 'signed_out' | 'no_team' | 'not_member' } | { readonly kind: 'team'; readonly team: Team };

/** The data of a Better Auth answer; its error (or an empty answer) throws with the issuer's message. */
function must<T>(result: { readonly data: T | null; readonly error: { readonly message?: string | undefined } | null }): T {
  if (result.data === null) throw new Error(result.error?.message ?? 'The team could not be read');
  return result.data;
}

/** The workspace's organization (its id is the workspace id), made active so MCP tokens this browser authorizes carry it as `org_id`. */
async function readTeam(organizationId: string): Promise<View> {
  const session = await auth.getSession();
  if (!session.data) return { kind: 'signed_out' };
  if (!must(await auth.organization.list()).some(organization => organization.id === organizationId)) {
    const free = await auth.organization.checkSlug({ slug: organizationId });
    if (free.data?.status) return { kind: 'no_team' };
    if (free.error?.code === 'ORGANIZATION_SLUG_ALREADY_TAKEN') return { kind: 'not_member' };
    throw new Error(free.error?.message ?? 'The team could not be read');
  }
  await auth.organization.setActive({ organizationId });
  const full = must(await auth.organization.getFullOrganization({ query: { organizationId } }));
  return { kind: 'team', team: { me: session.data.user.id, members: full.members, invitations: full.invitations.filter(invitation => invitation.status === 'pending') } };
}

/** Owners and admins manage the team. */
const manages = (actor: AccessScope['role']) => actor === 'owner' || actor === 'admin';

/** They change members other than themselves; only an owner changes or assigns `owner`. */
const editable = (member: Member, me: string, actor: AccessScope['role']) => manages(actor) && member.user.id !== me && (member.role !== 'owner' || actor === 'owner');

const assignable = (actor: AccessScope['role']) => (actor === 'owner' ? ROLES : ROLES.filter(role => role !== 'owner'));

function SignedOutNote({ task }: { task: string }) {
  return (
    <p className="text-ink-secondary">
      Your sign-in has ended. <a href={SIGN_IN_URL} className="text-ink underline decoration-accent underline-offset-4">Sign in again</a> to {task}.
    </p>
  );
}

/** Copies the invitation link; Sanctum sends no email, so the inviter sends it. */
function CopyLink({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className="shrink-0" onClick={() => void navigator.clipboard.writeText(inviteLink(id)).then(() => setCopied(true))}>
      {copied ? 'Copied' : 'Copy link'}
    </button>
  );
}

function RoleSelect({ roles, ...select }: { roles: ReadonlyArray<Role> } & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...select}>
      {roles.map(role => <option key={role} value={role}>{role}</option>)}
    </select>
  );
}

interface RowProps { readonly access: AccessScope; readonly team: Team; readonly busy: boolean; readonly change: Change }

function MemberRow({ member, access, team, busy, change }: RowProps & { member: Member }) {
  const organizationId = access.workspace_id;
  const remove = () => window.confirm(`Remove ${member.user.name}? They lose access to this workspace at once.`) && change(() => auth.organization.removeMember({ memberIdOrEmail: member.id, organizationId }));
  return (
    <li className={row}>
      <span className="min-w-0">
        <span className="text-ink">{member.user.name}</span>
        {member.user.id === team.me && <span className="text-ink-muted"> (you)</span>}
        <span className="block truncate text-xs text-ink-muted">{member.user.email}</span>
      </span>
      {editable(member, team.me, access.role) ? (
        <span className="flex items-center gap-3">
          <RoleSelect
            roles={assignable(access.role)}
            aria-label={`Role of ${member.user.name}`}
            className={`${field} py-1 text-xs`}
            value={member.role}
            disabled={busy}
            onChange={event => change(() => auth.organization.updateMemberRole({ memberId: member.id, role: event.target.value as Role, organizationId }))}
          />
          <button type="button" disabled={busy} onClick={remove}>Remove</button>
        </span>
      ) : (
        <span className="pr-2 font-mono text-xs text-ink-muted">{member.role}</span>
      )}
    </li>
  );
}

/** Email and role in; the new invitation's link out, shown until the dialog closes. */
function InviteForm({ access, busy, change }: Omit<RowProps, 'team'>) {
  const [invited, setInvited] = useState<{ id: string; email: string } | null>(null);
  const invite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = event.currentTarget;
    const form = new FormData(target);
    const email = String(form.get('email')).trim();
    change(async () => {
      const result = await auth.organization.inviteMember({ email, role: String(form.get('role')) as Role, organizationId: access.workspace_id });
      if (result.data) {
        setInvited({ id: result.data.id, email });
        target.reset();
      }
      return result;
    });
  };
  return (
    <>
      <h3>Invite someone</h3>
      <form onSubmit={invite} className="flex flex-wrap gap-2">
        <input name="email" type="email" required placeholder="name@example.com" aria-label="Email" className={`${field} flex-1 basis-56`} />
        <RoleSelect roles={INVITABLE} name="role" aria-label="Role" defaultValue="member" className={field} />
        <button type="submit" data-primary disabled={busy}>Invite</button>
      </form>
      <p className="mt-2 text-xs text-ink-muted">Whoever has the link and signs up with that email address joins, so share it only with that person. Only owners and admins see pending invitations. An owner is made by changing a member's role.</p>
      {invited && (
        <div role="status" className="mt-3 rounded bg-surface px-3 py-2.5">
          <p className="text-xs text-ink-secondary">
            Link for <span className="text-ink">{invited.email}</span>, valid for 48 hours. Sanctum sends no email, so send it yourself.
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink select-all">{inviteLink(invited.id)}</code>
            <CopyLink id={invited.id} />
          </div>
        </div>
      )}
    </>
  );
}

function PendingRow({ invitation, busy, change }: { invitation: Invitation; busy: boolean; change: Change }) {
  const expires = new Date(invitation.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <li className={row}>
      <span className="min-w-0">
        <span className="text-ink">{invitation.email}</span>
        <span className="block text-xs text-ink-muted">{invitation.role} · expires {expires}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <CopyLink id={invitation.id} />
        <button type="button" disabled={busy} onClick={() => change(() => auth.organization.cancelInvitation({ invitationId: invitation.id }))}>
          Cancel
        </button>
      </span>
    </li>
  );
}

function TeamList(props: RowProps) {
  const { access, team } = props;
  const manage = manages(access.role);
  return (
    <div className="listen-panel">
      <ul aria-label="Members" className="divide-y divide-divider border-b border-divider">
        {team.members.map(member => <MemberRow key={member.id} member={member} {...props} />)}
      </ul>
      {manage && <InviteForm {...props} />}
      {manage && team.invitations.length > 0 && (
        <>
          <h3>Pending invitations</h3>
          <ul aria-label="Pending invitations" className="divide-y divide-divider">
            {team.invitations.map(invitation => <PendingRow key={invitation.id} invitation={invitation} busy={props.busy} change={props.change} />)}
          </ul>
        </>
      )}
    </div>
  );
}

/** Only an owner creates the organization; the server refuses anyone else and names it after the workspace. */
function NoTeam({ access, busy, change }: Omit<RowProps, 'team'>) {
  const owner = access.role === 'owner';
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-ink-secondary">
      <p>{owner ? 'This workspace has no team yet. Set it up to invite people.' : 'An owner of this workspace sets up its team.'}</p>
      {owner && (
        <button type="button" data-primary disabled={busy} onClick={() => change(() => auth.organization.create({ name: 'Workspace', slug: access.workspace_id }))}>
          Set up team
        </button>
      )}
    </div>
  );
}

export function TeamDialog({ access, open, onClose }: { access: AccessScope; open: boolean; onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => readTeam(access.workspace_id).then(setView, (failure: Error) => setError(failure.message)), [access.workspace_id]);
  useEffect(() => {
    if (!open) return;
    setError(null);
    void load();
  }, [open, load]);

  const change: Change = action => {
    setBusy(true);
    setError(null);
    void action()
      .then(result => result.error && setError(`${result.error.message ?? 'The change failed'}.`))
      .then(load)
      .finally(() => setBusy(false));
  };

  const body = {
    loading: () => <p className="text-ink-muted">Loading…</p>,
    signed_out: () => <SignedOutNote task="manage the team" />,
    no_team: () => <NoTeam access={access} busy={busy} change={change} />,
    not_member: () => <p className="text-ink-secondary">This workspace has a team. Ask an owner to invite you.</p>,
    team: () => view.kind === 'team' && <TeamList access={access} team={view.team} busy={busy} change={change} />,
  };
  return (
    <Dialog title="Team" open={open} onClose={onClose}>
      {error && <p role="alert" className="mb-3 text-warning">{error}</p>}
      {body[view.kind]()}
    </Dialog>
  );
}

type Notice = { readonly text: string; readonly failed: boolean };

function NoticeLine({ notice }: { notice: Notice }) {
  return <p role={notice.failed ? 'alert' : 'status'} className={`mb-3 ${notice.failed ? 'text-warning' : 'text-ink'}`}>{notice.text}</p>;
}

/** Display name and password at the issuer; Sanctum takes the new name from the next sign-in. */
function ProfileForms({ name, onNotice }: { name: string; onNotice: (notice: Notice) => void }) {
  const [busy, setBusy] = useState(false);
  const submit = (action: (form: HTMLFormElement) => Promise<Result>, done: string) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    void action(event.currentTarget).then(({ error }) => {
      setBusy(false);
      onNotice(error ? { text: `${error.message ?? 'The change failed'}.`, failed: true } : { text: done, failed: false });
    });
  };
  return (
    <div className="listen-panel grid gap-2">
      <form onSubmit={submit(form => auth.updateUser({ name: String(new FormData(form).get('name')).trim() }), 'Name saved. Sanctum shows it after your next sign-in.')}>
        <label className="grid gap-1">
          <span className="text-xs text-ink-muted">Display name</span>
          <span className="flex gap-2">
            <input name="name" required maxLength={200} defaultValue={name} autoComplete="name" className={`${field} flex-1`} />
            <button type="submit" data-primary disabled={busy}>Save</button>
          </span>
        </label>
      </form>
      <h3>Password</h3>
      <form onSubmit={submit(async form => {
          // Empties the password fields once the change is saved.
          const fields = new FormData(form);
          const result = await auth.changePassword({ currentPassword: String(fields.get('current')), newPassword: String(fields.get('new')), revokeOtherSessions: true });
          if (!result.error) form.reset();
          return result;
        }, 'Password changed. Other browsers must sign in to the issuer again.')} className="flex flex-wrap gap-2">
        <input name="current" type="password" required autoComplete="current-password" placeholder="Current password" aria-label="Current password" className={`${field} flex-1 basis-40`} />
        <input name="new" type="password" required minLength={8} autoComplete="new-password" placeholder="New password" aria-label="New password" className={`${field} flex-1 basis-40`} />
        <button type="submit" data-primary disabled={busy}>Change password</button>
      </form>
    </div>
  );
}

export function ProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    setNotice(null);
    if (open) void auth.getSession().then(({ data }) => setName(data?.user.name ?? null));
  }, [open]);
  return (
    <Dialog title="Profile" open={open} onClose={onClose}>
      {notice && <NoticeLine notice={notice} />}
      {name === null ? <SignedOutNote task="edit your profile" /> : <ProfileForms name={name} onNotice={setNotice} />}
    </Dialog>
  );
}
