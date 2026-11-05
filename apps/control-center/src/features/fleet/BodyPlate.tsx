import type { Body } from '../../core/api/schemas';
import { signed } from '../../visitor/format';
import { humanize, StatusChip } from '../status';
import { BatteryGauge } from './BatteryGauge';
import { HeartbeatTrace } from './HeartbeatTrace';
import { ageOf, ageText, LATE_MS } from './heartbeats';

const degrees = (yaw: number) => {
  const value = Math.round((yaw * 180) / Math.PI);
  return value === 0 ? '0' : signed(value, 0);
};

export function BodyPlate({
  body,
  beats,
  now,
}: {
  readonly body: Body;
  readonly beats: readonly number[];
  readonly now: number;
}) {
  const age = ageOf(Date.parse(body.last_seen), now);
  const late = age > LATE_MS;
  const heading = `body-${body.id}`;
  return (
    <article className="plate body-plate" aria-labelledby={heading}>
      <header className="body-head">
        <div>
          <h2 id={heading}>{body.display_name}</h2>
          <p>
            {humanize(body.kind)} <code>{body.id}</code>
          </p>
        </div>
        <StatusChip status={body.status} />
      </header>
      <HeartbeatTrace
        beats={beats}
        now={now}
        offline={body.status === 'offline'}
        label={`Heartbeats from ${body.display_name} over the last 30 seconds; last report ${ageText(age).toLowerCase()}`}
      />
      <dl className="body-readouts">
        <div data-late={late ? '' : undefined}>
          <dt>Last report</dt>
          <dd className="figures">{ageText(age)}</dd>
        </div>
        <div>
          <dt>Battery</dt>
          <dd className="battery-reading">
            <BatteryGauge level={body.battery} />
            <span className="figures">{body.battery}%</span>
          </dd>
        </div>
        <div className="wide">
          <dt>Pose</dt>
          <dd className="figures">
            {body.pose
              ? `${signed(body.pose.x, 2)}, ${signed(body.pose.y, 2)} m, heading ${degrees(body.pose.yaw)}°`
              : 'Not reported'}
          </dd>
        </div>
        <div>
          <dt>Place</dt>
          <dd>{humanize(body.location)}</dd>
        </div>
        <div>
          <dt>Adapter</dt>
          <dd className="figures">{body.adapter_version}</dd>
        </div>
        <div className="wide">
          <dt>Can</dt>
          <dd className="capabilities">
            {body.capabilities.map((capability) => (
              <span key={capability}>{humanize(capability)}</span>
            ))}
          </dd>
        </div>
      </dl>
    </article>
  );
}
