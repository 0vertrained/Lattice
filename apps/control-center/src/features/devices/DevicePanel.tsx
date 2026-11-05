import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '../../core/api/apiClient';
import { GuardedAction } from '../guard/GuardedAction';
import { StatusChip } from '../status';
export function DevicePanel() {
  const client = useQueryClient();
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => apiClient.listDevices() });
  const [body, setBody] = useState('gazebo-rover');
  const [label, setLabel] = useState('Warehouse simulator');
  const [token, setToken] = useState('');
  const issue = useMutation({
    mutationFn: () => apiClient.issueDevice(body, label),
    onSuccess: async (result) => {
      setToken(result.token);
      await client.invalidateQueries({ queryKey: ['devices'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => apiClient.revokeDevice(id),
    onSuccess: async () => {
      setToken('');
      await client.invalidateQueries({ queryKey: ['devices'] });
    },
  });
  return (
    <section className="panel" aria-labelledby="devices-heading">
      <div className="section-heading">
        <h2 id="devices-heading">Robot identities</h2>
      </div>
      <p className="muted">
        Each credential can act only as its assigned body. Credentials expire after 30 days and can
        be revoked immediately.
      </p>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          setToken('');
          issue.mutate();
        }}
      >
        <label>
          Body ID
          <input
            required
            pattern="[A-Za-z0-9_.:-]{3,64}"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <label>
          Credential label
          <input
            required
            minLength={3}
            maxLength={80}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <button type="submit" disabled={issue.isPending}>
          Issue robot credential
        </button>
      </form>
      {token && (
        <div className="review-box">
          <p>
            Save this credential to the robot’s private token file. It is shown once and is cleared
            when you leave.
          </p>
          <label>
            New robot credential
            <input type="password" readOnly value={token} />
          </label>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(token);
            }}
          >
            Copy credential
          </button>
          <button type="button" className="secondary" onClick={() => setToken('')}>
            Hide credential
          </button>
        </div>
      )}
      <h3 className="device-list-title">Issued credentials</h3>
      <div className="device-list">
        {devices.data?.map((d) => (
          <article key={d.id}>
            <div className="card-title-row">
              <div>
                <strong>{d.label}</strong>
                <small>
                  <code>{d.body_id}</code>, expires {new Date(d.expires_at).toLocaleDateString()}
                </small>
              </div>
              {d.revoked_at ? (
                <StatusChip status="cancelled" label="Revoked" />
              ) : (
                <GuardedAction
                  danger
                  label={`Revoke ${d.label}`}
                  confirmLabel="Confirm revoke"
                  consequence={`${d.body_id} loses access immediately. The robot must be given a new credential before it can connect again.`}
                  pending={revoke.isPending && revoke.variables === d.id}
                  pendingLabel="Revoking…"
                  disabled={revoke.isPending}
                  onConfirm={() => revoke.mutate(d.id)}
                />
              )}
            </div>
          </article>
        ))}
      </div>
      {(issue.error || revoke.error || devices.error) && (
        <p role="alert" className="notice error">
          {(issue.error || revoke.error || devices.error)?.message}
        </p>
      )}
    </section>
  );
}
