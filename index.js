const https = require("https");
const fs = require("fs");
const path = require("path");

if (!process.env.USER_REPO) {
  console.log("The environment variable USER_REPO does not exists.");
  process.exit(1);
}

const BASE_API_URL = `https://api.github.com/repos/${process.env.USER_REPO}`;

const OUTPUT_DIRECTORY = path.resolve(__dirname, "data");

if (!process.env.MAX_PAGE) {
  console.log("The environment variable MAX_PAGE does not exists.");
  process.exit(1);
}

const MAX_PAGE = parseInt(process.env.MAX_PAGE, 10); // meaning MAX_PAGES * 100 PRs will be processed

const getOutputFilename = (filename) =>
  path.resolve(OUTPUT_DIRECTORY, filename);
const PRS_FILE = getOutputFilename("prs.json");

const PR_REVIEWS_URL = (id) =>
  `${BASE_API_URL}/pulls/${id}/reviews?per_page=100`;

const PRS_URL = (page = 0) =>
  `${BASE_API_URL}/pulls?state=closed&per_page=100&page=${page}`;

if (!process.env.GITHUB_ACCESS_TOKEN) {
  console.log("The environment variable GITHUB_ACCESS_TOKEN does not exists.");
  process.exit(1);
}

if (!process.env.GITHUB_HANDLES) {
  console.log(
    'The environment variable GITHUB_HANDLES does not exists. Usage: GITHUB_HANDLES="user1,user2"'
  );
  process.exit(1);
}

let pulls = {};
try {
  pulls = require(PRS_FILE);
  console.log(`Loaded PRs from ${PRS_FILE}`);
} catch (e) {
  // do nothing
}

const GITHUB_HANDLES = process.env.GITHUB_HANDLES.split(",");

const query = (url) =>
  new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          "user-agent": "node.js",
          Accept: "application/vnd.github.v3+json",
          Authorization: `token ${process.env.GITHUB_ACCESS_TOKEN}`,
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (data) => {
          body += data;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(body);
            if (json.message.match(/API rate limit exceeded for user ID/))
              return reject(`API rate limit exceeded (${url})`);
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
  });

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
    arr.slice(i * size, i * size + size)
  );

const isApprovedBy = (handle, reviews) =>
  reviews.some(
    ({ user, state }) => user && user.login === handle && state === "APPROVED" // deleted users show up as null
  );

const isCommentedBy = (handle, comments) =>
  comments.some(({ user, state }) => user.login === handle);

const handlePr = async (pr) => {
  if (GITHUB_HANDLES.every((handle) => pr[handle] !== undefined)) return pr;
  const { comments_url, number, closed_at, html_url } = pr;
  const reviews = await query(PR_REVIEWS_URL(number));
  const comments = await query(comments_url);

  return {
    number,
    ...GITHUB_HANDLES.reduce(
      (acc, handle) => ({
        ...acc,
        [handle]: isApprovedBy(handle, reviews)
          ? "APPR"
          : isCommentedBy(handle, comments)
          ? "COMM"
          : null,
      }),
      {}
    ),
  };
};

const printResults = (pulls) => {
  const finalResults = Object.values(pulls)
    .map(({ number, closed_at, html_url, ...pr }) => ({
      number,
      closed_at: new Date(closed_at).toISOString().split("T")[0],
      html_url,
      ...GITHUB_HANDLES.reduce(
        (acc, handle) => ({ ...acc, [handle]: pr[handle] }),
        {}
      ),
    }))
    .filter((r) =>
      GITHUB_HANDLES.some(
        (handle) => r[handle] !== undefined && r[handle] !== null
      )
    )
    .sort((a, b) => +new Date(a.closed_at) - +new Date(b.closed_at));

  const lastRow = GITHUB_HANDLES.reduce(
    (acc, handle) => ({
      ...acc,
      [handle]: finalResults.filter((row) => row[handle] !== null).length,
    }),
    { number: null, closed_at: null, html_url: null }
  );

  finalResults.push(lastRow);
  console.table(finalResults);
};

const main = async () => {
  if (process.env.SKIP) return printResults(pulls);

  let page = 0;
  while (page < MAX_PAGE && !process.env.SKIP_PRS_FETCHING) {
    console.log(`Querying page ${page}`);
    let prs = null;
    try {
      prs = await query(PRS_URL(page));
      pulls = prs
        .filter((pr) => !pulls[pr.number])
        .map(({ comments_url, number, closed_at, html_url }) => ({
          comments_url,
          number,
          closed_at,
          html_url,
        }))
        .reduce((acc, pr) => ({ ...acc, [pr.number]: pr }), pulls);
      fs.writeFileSync(PRS_FILE, JSON.stringify(pulls, null, 2));
    } catch (e) {
      console.error(e);
      console.error({ prs });
      page -= 1;
    }
    page += 1;
  }

  const pullChunks = chunk(Object.values(pulls), 20);
  for (let i = 0; i < pullChunks.length; i++) {
    const chunk = pullChunks[i];
    console.log(
      `Iterating over PR chunk number ${i + 1} out of ${pullChunks.length}`
    );
    const res = await Promise.all(chunk.map(handlePr));
    pulls = res.reduce(
      (acc, pr) => ({ ...acc, [pr.number]: { ...acc[pr.number], ...pr } }),
      pulls
    );
    fs.writeFileSync(PRS_FILE, JSON.stringify(pulls, null, 2));
  }

  printResults(pulls);
};

main();
