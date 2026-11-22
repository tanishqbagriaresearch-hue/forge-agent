export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

export class Bm25 {
  private docs: string[][];
  private df = new Map<string, number>();
  private avgdl: number;
  constructor(docs: string[], private k1 = 1.5, private b = 0.75) {
    this.docs = docs.map(tokenize);
    for (const d of this.docs) for (const t of new Set(d)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgdl = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length);
  }
  score(query: string): number[] {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    return this.docs.map((d) => {
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
      let s = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.length) / this.avgdl));
      }
      return s;
    });
  }
}
