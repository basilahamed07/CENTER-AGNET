declare module 'pidusage' {
  interface PidUsageStat {
    cpu: number;
    memory: number;
    ppid?: number;
    pid: number;
    ctime?: number;
    elapsed?: number;
    timestamp?: number;
  }

  function pidusage(pid: number): Promise<PidUsageStat>;
  export default pidusage;
}
