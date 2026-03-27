import "dotenv/config";
import { fetchFilterAndSearch } from "./site-search.js";

const LINK = process.argv[2] ?? "https://docs.npmjs.com";
const QUERY = process.argv[3] ?? "how to publish a package";

console.log(`\nLink       : ${LINK}`);
console.log(`Query      : ${QUERY}\n`);

fetchFilterAndSearch(LINK, QUERY)
  .then((result) => {
    console.log(`\nFound content: ${result.foundContent}`);
    console.log(`Source URL   : ${result.sourceUrl}`);
    console.log("\n--- Filtered Answer ---\n");
    console.log(result.answer);
    process.exit(0);
  })
  .catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
