declare module 'better-sqlite3' {
  interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  interface Database {
    pragma(source: string): unknown;
    prepare(source: string): Statement;
  }

  const Database: {
    new (filename: string): Database;
  };

  export default Database;
}
