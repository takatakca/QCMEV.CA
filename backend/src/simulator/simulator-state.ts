/**
 * Persistent state of the local simulator (throwaway CA, issued device certificates, chains, registered users).
 * Stored as JSON in MEV_SIMULATOR_STATE_DIR (default: the OS temp folder), never in the repository,
 * so the simulator keeps working across a backend restart. Test data only.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SimDevice {
  certPem: string;
  thumbprint: string;
  lastSignature: string | null;
  users: string[];
  seen: Record<string, string>;
  counter: number;
}

export interface SimState {
  ca: { keyPem: string; certPem: string } | null;
  devices: Record<string, SimDevice>;
  transactions: Record<string, { idApprl: string; noTrans: string; datTrans: string; apresTax: string; psiNoTrans: string }>;
  docs: number;
}

export class SimulatorStore {
  private state: SimState;
  private readonly file: string;

  constructor(dir: string, port: number) {
    const base = dir || path.join(os.tmpdir(), `qcmev-simulator-${port}`);
    fs.mkdirSync(base, { recursive: true });
    this.file = path.join(base, 'state.json');
    this.state = this.read();
  }

  private read(): SimState {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as SimState;
    } catch {
      return { ca: null, devices: {}, transactions: {}, docs: 0 };
    }
  }

  get(): SimState {
    return this.state;
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }
}
