declare module 'better-sqlite3' {
  interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  interface Database {
    pragma(source: string): unknown;
    prepare(source: string): Statement;
    close(): void;
  }

  interface DatabaseOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
  }

  const Database: {
    new (filename: string, options?: DatabaseOptions): Database;
  };

  export default Database;
}
