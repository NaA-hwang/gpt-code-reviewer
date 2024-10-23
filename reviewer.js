import fetch from "node-fetch";
import * as dotenv from 'dotenv';

(async () => {
    const { Octokit } = await import("@octokit/rest");
    const OpenAI = (await import("openai")).default;

    // dotenv 설정
    dotenv.config();

    // GitHub와 OpenAI API 설정
    const octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
        request: {
            fetch: fetch,
        }
    });

    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });

    // Get GitHub Actions permissions for an organization
    await octokit.request('GET /orgs/{org}/actions/permissions', {
        org: 'Woka-inc',
        headers: {
            'X-GitHub-Api-Version': '2022-11-28'
        }
    })

    // 전체 과정
    async function runReview(owner, repo, pull_number, base, head) {
        try {
            const MAX_PATCH_COUNT = process.env.MAX_PATCH_LENGTH
                ? +process.env.MAX_PATCH_LENGTH
                : Infinity;
            // 두 커밋 간의 변경 사항 가져오기 (compareCommits 사용)
            const { data } = await octokit.repos.compareCommits({
                owner: owner,
                repo: repo,
                base: base,
                head: head,
            })
            let { files: changedFiles, commits } = data;
            if (commits.length >= 2) {
                const { data: { files }, } = await octokit.repos.compareCommits({
                    owner: owner,
                    repo: repo,
                    base: commits[commits.length - 2].sha,
                    head: commits[commits.length - 1].sha
                })
                const ignoreList = (process.env.IGNORE || process.env.ignore || '')
                    .split('\n')
                    .filter((v) => v !== '');
                const filesNames = files?.map((file) => file.filename) || [];
                changedFiles = changedFiles?.filter((file) => filesNames.includes(file.filename) &&
                    !ignoreList.includes(file.filename));
            }
            if (!changedFiles?.length) {
                console.log('no change found');
                return 'no change';
            }
            // 변경사항이 있으면 각 변경사항마다 codeReview 진행
            for (let i = 0; i < changedFiles.length; i++) {
                const file = changedFiles[i];
                const patch = file.patch || '';
                if (!patch || patch.length > MAX_PATCH_COUNT) {
                    console.log(`${file.filename} skipped caused by its diff is too large`);
                    continue;
                }
                try {
                    const res = await codeReview(patch);
                    if (!!res) {
                        await octokit.pulls.createReviewComment({
                            repo: repo,
                            owner: owner,
                            pull_number: pull_number,
                            commit_id: commits[commits.length - 1].sha,
                            path: file.filename,
                            body: res,
                            position: patch.split('\n').length - 1,
                        });
                    }
                    console.log("Review comments posted successfully!");
                }
                catch (e) {
                    console.error(`review ${file.filename} failed`, e);
                }
            }
        } catch (error) {
            console.error(`Error comparing commits: ${base}...${head}`);
            console.error(error.message);
            throw error; // 다시 예외를 던져서 상위 함수에서 처리할 수 있게함
        }
    }

    //프롬프트 생성 1단계
    function generatePrompt(patch) {
        const prompt = `
        Answer me in Korean.
        Below is a code patch, please help me do a brief code review on it.
        Summarize what changes the code patch has.
        Any but risks and/or improvement suggestions are welcome
        `
        return `${prompt}
        ${patch}`;
    }

    // 프롬프트 만들고 응답 받아오는 2단계
    async function codeReview(patch) {
        if (!patch) { return ''; }
        const prompt = generatePrompt(patch);
        // prompt가 문자열인지 확인
        if (typeof prompt !== 'string') {
            throw new Error("Generated prompt is not a string");
        }
        // 응답 생성
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system", content: `# Code Review Guidelines
* You SHOULD answer in Korean.
* You are a strict and thorough code reviewer. You must always provide honest feedback without any inaccuracies.
* Evaluate the code added or modified through Pull Requests.
* According to the evaluation criteria provided, if the code patch has any of the following issues, give the user feedback.
* There are four evaluation criteria. If multiple issues fall under a single criterion, address them in detail.
* Feedback format:
    1. Issue Description: Describe the issue according to the evaluation criteria.
    2. Relevant Lines: Specify the line range where the issue occurs in the format "[line_num]-[line_num]".
    3. Suggested Code: Include the revised code based on the feedback.
* If there are no issues, say that there is no issue.
# Evaluation Criteria
1. Pre-condition Check
    * Verify whether a function or method has the correct state or range of values for variables needed to operate properly.
2. Runtime Error Check
    * Identify potential runtime errors and other risks in the code.
3. Security Issue
    * Detect the use of modules with serious security flaws or any security vulnerabilities in the code.
4. Optimization
    * Suggest optimized code if there are performance issues in the code patch.
# Feedback Example
* When an issue is identified:
    * Issue Description: "The variable is used without a pre-condition check."
    * Relevant Lines: "10-12"
    * Suggested Code:`},
                { role: "user", content: prompt }
            ],
            max_tokens: 1000,
            temperature: 0,
        });
        return response.choices[0].message.content;
    }


    // 전체 리뷰 생성 및 게시 프로세스
    async function reviewPullRequest(owner, repo, pull_number, base, head) {
        try {
            runReview(owner, repo, pull_number, base, head) 
        } catch (error) {
            console.error("Error:", error);
        }
    }

    // 환경 변수로부터 프로젝트 정보 가져오기
    const owner = process.env.GITHUB_OWNER;  // GitHub 사용자 또는 조직 이름
    const repo = process.env.GITHUB_REPOSITORY_NAME;  // 리포지토리 이름
    const pull_number = process.env.GITHUB_PR_NUMBER;  // PR 번호
    const base = process.env.GITHUB_BASE_COMMIT;  // 비교할 기준 커밋
    const head = process.env.GITHUB_HEAD_COMMIT;  // 비교할 최신 커밋

    reviewPullRequest(owner, repo, pull_number, base, head);

})();
