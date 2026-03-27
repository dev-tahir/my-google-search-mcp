// formatter.ts — Shared types and Markdown formatter for Google search results

export interface SearchResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
}

export interface GoogleSearchData {
  query: string;
  aiOverview: string | null;
  featuredSnippet: string | null;
  peopleAlsoAsk: string[];
  organicResults: SearchResult[];
  knowledgePanel: string | null;
}

export function formatMarkdown(data: GoogleSearchData): string {
  const lines: string[] = [];
  lines.push(`# Google Search Results\n`);
  lines.push(`**Query:** \`${data.query}\`\n`);
  lines.push(`---\n`);

  if (data.aiOverview) {
    lines.push(`## 🤖 AI Overview\n`);
    lines.push(`${data.aiOverview}\n`);
    lines.push(`---\n`);
  }

  if (data.featuredSnippet && data.featuredSnippet !== data.aiOverview) {
    lines.push(`## ⭐ Featured Snippet\n`);
    lines.push(`${data.featuredSnippet}\n`);
    lines.push(`---\n`);
  }

  if (data.knowledgePanel) {
    lines.push(`## 📋 Knowledge Panel\n`);
    lines.push(`${data.knowledgePanel}\n`);
    lines.push(`---\n`);
  }

  if (data.organicResults.length > 0) {
    lines.push(`## 🔍 Organic Results\n`);
    for (const r of data.organicResults) {
      lines.push(`### ${r.rank}. [${r.title}](${r.url})`);
      if (r.snippet) lines.push(`> ${r.snippet.replace(/\n/g, " ")}`);
      lines.push(``);
    }
    lines.push(`---\n`);
  }

  if (data.peopleAlsoAsk.length > 0) {
    lines.push(`## ❓ People Also Ask\n`);
    const unique = [...new Set(data.peopleAlsoAsk)].slice(0, 8);
    for (const q of unique) lines.push(`- ${q}`);
    lines.push(``);
  }

  return lines.join("\n");
}
