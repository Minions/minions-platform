export interface SecretaryStatus {
  isActive: boolean;
  lastActivity: string | null;
}

export class CodeExecutionSecretary {
  private isActive = false;
  private lastActivity: string | null = null;

  getStatus(): SecretaryStatus {
    return {
      isActive: this.isActive,
      lastActivity: this.lastActivity,
    };
  }
}