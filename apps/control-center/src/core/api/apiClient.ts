import { z } from 'zod';
import {
  type AuditRecord,
  auditRecordSchema,
  type Body,
  bodySchema,
  type CreateMissionRequest,
  type Mission,
  missionSchema,
  type Proposal,
  proposalSchema,
} from './schemas';

const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

class ApiClient {
  private apiKey = '';
  private readonly baseUrl = '/api/v1';

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey.trim();
  }

  clearApiKey(): void {
    this.apiKey = '';
  }

  hasApiKey(): boolean {
    return this.apiKey.length >= 32;
  }

  async health(): Promise<boolean> {
    const response = await fetch('/api/health', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    return response.ok;
  }

  async listBodies(): Promise<readonly Body[]> {
    const payload = await this.request('/bodies');
    return z.array(bodySchema).parse(payload);
  }

  async listMissions(): Promise<readonly Mission[]> {
    const payload = await this.request('/missions');
    return z.array(missionSchema).parse(payload);
  }

  async propose(request: CreateMissionRequest): Promise<Proposal> {
    return proposalSchema.parse(
      await this.request('/proposals', {
        method: 'POST',
        body: JSON.stringify(request),
      }),
    );
  }

  async plan(userIntent: string): Promise<Proposal> {
    return proposalSchema.parse(
      await this.request('/proposals/plan', {
        method: 'POST',
        body: JSON.stringify({ user_intent: userIntent }),
      }),
    );
  }

  async approve(proposal: Proposal): Promise<Mission> {
    return missionSchema.parse(
      await this.request(`/proposals/${proposal.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ digest: proposal.digest }),
      }),
    );
  }

  async proposeRecovery(missionId: string): Promise<Proposal> {
    return proposalSchema.parse(
      await this.request(`/missions/${encodeURIComponent(missionId)}/recovery-proposal`, {
        method: 'POST',
        body: '{}',
      }),
    );
  }

  async listProposals(): Promise<readonly Proposal[]> {
    return z.array(proposalSchema).parse(await this.request('/proposals'));
  }

  async exportTrace(): Promise<void> {
    const [proposals, missions, audit] = await Promise.all([
      this.listProposals(),
      this.listMissions(),
      this.listAudit(),
    ]);
    const blob = new Blob(
      [
        JSON.stringify(
          { exported_at: new Date().toISOString(), proposals, missions, audit },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lattice-demo-trace.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async reassignUnavailable(): Promise<readonly Mission[]> {
    const payload = await this.request('/missions/reassign', {
      method: 'POST',
      body: '{}',
    });
    return z.array(missionSchema).parse(payload);
  }

  async listAudit(): Promise<readonly AuditRecord[]> {
    const payload = await this.request('/audit');
    return z.array(auditRecordSchema).parse(payload);
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.hasApiKey()) {
      throw new ApiError(401, 'missing_api_key', 'A development API key is required.');
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-lattice-api-key': this.apiKey,
        ...init.headers,
      },
    });

    if (response.status === 204) {
      return null;
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(payload);
      throw new ApiError(
        response.status,
        parsed.success ? parsed.data.code : 'request_failed',
        parsed.success ? parsed.data.message : 'Lattice Core rejected the request.',
      );
    }

    return payload;
  }
}

export const apiClient = new ApiClient();
