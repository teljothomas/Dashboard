import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeviceDto, SessionDto, UserDto } from '@tradex/contracts';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import {
  Badge,
  FormError,
  InfoNote,
  primaryButtonClass,
  secondaryButtonClass,
  TextField,
} from '../../components/ui/form';
import { formatDateTime } from '../../lib/datetime';
import { t } from '../../lib/i18n';
import { useAuth } from '../auth/authStore';
import {
  adminKeys,
  getUser,
  issueResetCode,
  listUserDevices,
  listUserSessions,
  revokeAllUserSessions,
  revokeDevice,
  revokeSession,
  unlockUser,
  updateUser,
  type RoleAssignmentBody,
} from './adminApi';
import { adminErrorMessage } from './adminErrors';
import { RolePicker } from './RolePicker';
import { userStatusBadge } from './UsersPage';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function UserDetailPage() {
  const { id = '' } = useParams();
  const user = useQuery({
    queryKey: adminKeys.user(id),
    queryFn: () => getUser(id),
    enabled: id !== '',
  });

  return (
    <div className="space-y-4">
      <p>
        <Link to="/admin/users" className="inline-block min-h-11 py-3 text-sky-700 underline">
          {t('admin.users.back')}
        </Link>
      </p>
      {user.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {user.isError ? <FormError message={adminErrorMessage(user.error)} /> : null}
      {user.isSuccess ? <UserDetail key={user.data.id} user={user.data} /> : null}
    </div>
  );
}

function UserDetail({ user }: { user: UserDto }) {
  const { identity } = useAuth();
  const self = identity?.user.id === user.id;
  const queryClient = useQueryClient();

  const refreshUser = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: adminKeys.user(user.id) });
    await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{user.displayName}</h1>
        <p className="text-sm text-slate-600">{user.username}</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
          {userStatusBadge(user.status)}
          {user.mustChangePassword ? (
            <Badge tone="amber">{t('admin.users.mustChange')}</Badge>
          ) : null}
          <span>
            {user.lastLoginAt === null
              ? t('admin.users.neverSignedIn')
              : t('admin.users.lastLogin', { when: formatDateTime(user.lastLoginAt) })}
          </span>
        </p>
      </div>

      <ProfileSection user={user} onSaved={refreshUser} />
      <AccessSection user={user} self={self} onSaved={refreshUser} />
      <PasswordSection user={user} self={self} onChanged={refreshUser} />
      <SessionsSection userId={user.id} />
      <DevicesSection userId={user.id} />
    </div>
  );
}

function ProfileSection({ user, onSaved }: { user: UserDto; onSaved: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [phone, setPhone] = useState(user.phone ?? '');
  const save = useMutation({
    mutationFn: () =>
      updateUser(user.id, {
        displayName: displayName.trim(),
        phone: phone.trim() === '' ? null : phone.trim(),
      }),
    onSuccess: onSaved,
  });

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!save.isPending) save.mutate();
  }

  return (
    <Section title={t('admin.users.profile')}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <TextField
          label={t('admin.users.displayName')}
          name="displayName"
          required
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
          }}
        />
        <TextField
          label={t('admin.users.phone')}
          name="phone"
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
          }}
        />
        {save.isError ? <FormError message={adminErrorMessage(save.error)} /> : null}
        {save.isSuccess ? <InfoNote>{t('common.saved')}</InfoNote> : null}
        <button
          type="submit"
          className={primaryButtonClass}
          disabled={save.isPending || displayName.trim() === ''}
        >
          {t('common.save')}
        </button>
      </form>
    </Section>
  );
}

function AccessSection({
  user,
  self,
  onSaved,
}: {
  user: UserDto;
  self: boolean;
  onSaved: () => Promise<void>;
}) {
  const [roleIds, setRoleIds] = useState<ReadonlySet<string>>(
    new Set(user.roles.map((role) => role.roleId)),
  );
  const limited = user.roles.filter((role) => role.divisionId !== null);

  const saveRoles = useMutation({
    mutationFn: () => {
      // Keep the division limiter of every assignment that stays; new ones start without one.
      const roles: RoleAssignmentBody[] = [];
      for (const roleId of roleIds) {
        const existing = user.roles.filter((assignment) => assignment.roleId === roleId);
        if (existing.length === 0) roles.push({ roleId, divisionId: null });
        else for (const a of existing) roles.push({ roleId, divisionId: a.divisionId });
      }
      return updateUser(user.id, { roles });
    },
    onSuccess: onSaved,
  });

  const setStatus = useMutation({
    mutationFn: (status: 'ACTIVE' | 'DISABLED') => updateUser(user.id, { status }),
    onSuccess: onSaved,
  });

  function toggleRole(roleId: string): void {
    setRoleIds((current) => {
      const next = new Set(current);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  return (
    <Section title={t('admin.users.access')}>
      {self ? <InfoNote>{t('admin.users.selfNote')}</InfoNote> : null}
      <RolePicker selected={roleIds} onToggle={toggleRole} disabled={self} />
      {limited.length > 0 ? (
        <InfoNote>{t('admin.users.divisionLimited', { count: limited.length })}</InfoNote>
      ) : null}
      {saveRoles.isError ? <FormError message={adminErrorMessage(saveRoles.error)} /> : null}
      {saveRoles.isSuccess ? <InfoNote>{t('common.saved')}</InfoNote> : null}
      <button
        type="button"
        className={primaryButtonClass}
        disabled={self || saveRoles.isPending}
        onClick={() => {
          saveRoles.mutate();
        }}
      >
        {t('admin.users.saveRoles')}
      </button>

      <hr className="border-slate-200" />
      {setStatus.isError ? <FormError message={adminErrorMessage(setStatus.error)} /> : null}
      {user.status === 'DISABLED' ? (
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={self || setStatus.isPending}
          onClick={() => {
            setStatus.mutate('ACTIVE');
          }}
        >
          {t('admin.users.enable')}
        </button>
      ) : (
        <ConfirmAction
          label={t('admin.users.disable')}
          warning={t('admin.users.disableWarning')}
          confirmLabel={t('admin.users.disableConfirm')}
          disabled={self || setStatus.isPending}
          onConfirm={() => {
            setStatus.mutate('DISABLED');
          }}
        />
      )}
    </Section>
  );
}

function PasswordSection({
  user,
  self,
  onChanged,
}: {
  user: UserDto;
  self: boolean;
  onChanged: () => Promise<void>;
}) {
  // The reset code lives in component state only: shown once, never cached or stored.
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | undefined>();
  const [copyFailed, setCopyFailed] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | undefined>();

  const unlock = useMutation({ mutationFn: () => unlockUser(user.id), onSuccess: onChanged });

  async function onIssue(): Promise<void> {
    setIssuing(true);
    setIssueError(undefined);
    setCopyFailed(false);
    try {
      setIssued(await issueResetCode(user.id));
    } catch (err) {
      setIssued(undefined);
      setIssueError(adminErrorMessage(err));
    } finally {
      setIssuing(false);
    }
  }

  async function onCopy(): Promise<void> {
    if (issued === undefined) return;
    try {
      await navigator.clipboard.writeText(issued.code);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <Section title={t('admin.users.password')}>
      {issued === undefined ? (
        <>
          <p className="text-sm text-slate-600">{t('admin.users.resetIntro')}</p>
          <FormError message={issueError} />
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={self || user.status !== 'ACTIVE' || issuing}
            onClick={() => {
              void onIssue();
            }}
          >
            {t('admin.users.resetIssue')}
          </button>
        </>
      ) : (
        <div role="region" aria-label={t('admin.users.resetCodeLabel')} className="space-y-3">
          <p className="text-sm text-slate-700">{t('admin.users.resetShownOnce')}</p>
          <p
            data-testid="reset-code"
            className="rounded-md bg-slate-100 px-3 py-3 text-center font-mono text-2xl tracking-widest select-all"
          >
            {issued.code}
          </p>
          <p className="text-sm text-slate-600">
            {t('admin.users.resetExpires', { when: formatDateTime(issued.expiresAt) })}
          </p>
          {copyFailed ? <FormError message={t('admin.users.copyFailed')} /> : null}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => {
                void onCopy();
              }}
            >
              {t('admin.users.copy')}
            </button>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                setIssued(undefined);
                setCopyFailed(false);
              }}
            >
              {t('admin.users.resetDone')}
            </button>
          </div>
        </div>
      )}

      <hr className="border-slate-200" />
      {unlock.isError ? <FormError message={adminErrorMessage(unlock.error)} /> : null}
      {unlock.isSuccess ? <InfoNote>{t('admin.users.unlocked')}</InfoNote> : null}
      <button
        type="button"
        className={secondaryButtonClass}
        disabled={unlock.isPending}
        onClick={() => {
          unlock.mutate();
        }}
      >
        {t('admin.users.unlock')}
      </button>
    </Section>
  );
}

function SessionsSection({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: adminKeys.sessions(userId),
    queryFn: () => listUserSessions(userId),
  });
  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: adminKeys.sessions(userId) });
  const revokeOne = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: refresh,
  });
  const revokeAll = useMutation({
    mutationFn: () => revokeAllUserSessions(userId),
    onSuccess: refresh,
  });
  const error = revokeOne.error ?? revokeAll.error ?? sessions.error;

  return (
    <Section title={t('admin.sessions.title')}>
      {sessions.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {error === null ? null : <FormError message={adminErrorMessage(error)} />}
      {sessions.isSuccess && sessions.data.length === 0 ? (
        <p className="text-sm text-slate-600">{t('admin.sessions.none')}</p>
      ) : null}
      <ul className="space-y-2">
        {(sessions.data ?? []).map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            busy={revokeOne.isPending}
            onRevoke={() => {
              revokeOne.mutate(session.id);
            }}
          />
        ))}
      </ul>
      {sessions.isSuccess && sessions.data.length > 0 ? (
        <ConfirmAction
          label={t('admin.sessions.revokeAll')}
          warning={t('admin.sessions.revokeAllWarning')}
          confirmLabel={t('admin.sessions.revokeAllConfirm')}
          disabled={revokeAll.isPending}
          onConfirm={() => {
            revokeAll.mutate();
          }}
        />
      ) : null}
    </Section>
  );
}

function SessionRow({
  session,
  busy,
  onRevoke,
}: {
  session: SessionDto;
  busy: boolean;
  onRevoke: () => void;
}) {
  return (
    <li className="space-y-1 rounded-md border border-slate-200 p-3 text-sm">
      <p className="break-words">{session.userAgent ?? t('admin.sessions.unknownAgent')}</p>
      <p className="text-slate-600">
        {session.ip ?? '-'} ·{' '}
        {t('admin.sessions.lastSeen', { when: formatDateTime(session.lastSeenAt) })}
      </p>
      <p className="text-slate-600">
        {t('admin.sessions.expires', { when: formatDateTime(session.expiresAt) })}
      </p>
      <button type="button" className={secondaryButtonClass} disabled={busy} onClick={onRevoke}>
        {t('admin.sessions.revoke')}
      </button>
    </li>
  );
}

function DevicesSection({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const devices = useQuery({
    queryKey: adminKeys.devices(userId),
    queryFn: () => listUserDevices(userId),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeDevice(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.devices(userId) });
      await queryClient.invalidateQueries({ queryKey: adminKeys.sessions(userId) });
    },
  });
  const error = revoke.error ?? devices.error;

  return (
    <Section title={t('admin.devices.title')}>
      {devices.isPending ? <p className="text-slate-600">{t('common.loading')}</p> : null}
      {error === null ? null : <FormError message={adminErrorMessage(error)} />}
      {devices.isSuccess && devices.data.length === 0 ? (
        <p className="text-sm text-slate-600">{t('admin.devices.none')}</p>
      ) : null}
      <ul className="space-y-2">
        {(devices.data ?? []).map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            busy={revoke.isPending}
            onRevoke={() => {
              revoke.mutate(device.id);
            }}
          />
        ))}
      </ul>
    </Section>
  );
}

function DeviceRow({
  device,
  busy,
  onRevoke,
}: {
  device: DeviceDto;
  busy: boolean;
  onRevoke: () => void;
}) {
  return (
    <li className="space-y-2 rounded-md border border-slate-200 p-3 text-sm">
      <p className="flex items-center justify-between gap-2">
        <span className="font-medium break-all">
          {device.label ?? device.platform ?? device.id}
        </span>
        {device.revokedAt === null ? null : <Badge tone="red">{t('admin.devices.revoked')}</Badge>}
      </p>
      <p className="text-slate-600">
        {t('admin.devices.firstSeen', { when: formatDateTime(device.firstSeenAt) })}
        {device.lastSyncAt === null
          ? ''
          : ` · ${t('admin.devices.lastSync', { when: formatDateTime(device.lastSyncAt) })}`}
      </p>
      {device.revokedAt === null ? (
        <ConfirmAction
          label={t('admin.devices.revoke')}
          warning={t('admin.devices.revokeWarning')}
          confirmLabel={t('admin.devices.revokeConfirm')}
          disabled={busy}
          onConfirm={onRevoke}
        />
      ) : null}
    </li>
  );
}
