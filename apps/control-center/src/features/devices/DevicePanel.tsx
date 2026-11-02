import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '../../core/api/apiClient';
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
        <div>
          <p className="eyebrow">Administrator</p>
          <h2 id="devices-heading">Robot identities</h2>
        </div>
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
      <div className="mission-list">
        {devices.data?.map((d) => (
          <article key={d.id}>
            <div className="card-title-row">
              <div>
                <strong>{d.label}</strong>
                <small>
                  {d.body_id} · expires {new Date(d.expires_at).toLocaleDateString()}
                </small>
              </div>
              {d.revoked_at ? (
                <span className="status-pill">Revoked</span>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(d.id)}
                >
                  Revoke {d.label}
                </button>
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
