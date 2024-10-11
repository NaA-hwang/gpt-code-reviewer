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

    // 전체 과정
    async function runReview(owner, repo, base, head, pull_number) {
        const MAX_PATCH_COUNT = process.env.MAX_PATCH_LENGTH
            ? +process.env.MAX_PATCH_LENGTH
            : Infinity;
        // 두 커밋 간의 변경 사항 가져오기 (compareCommits 사용)
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/compare/{base}...{head}', {
            owner: owner,
            repo: repo,
            base: base,
            head: head
        })
        // const { data } = await octokit.repos.compareCommits({
        //     owner: owner,
        //     repo: repo,
        //     basehead: `${base}...${head}`
        // });
        let { files: changedFiles, commits } = data.data;
        if (commits.length >= 2) {
            const { data: { files }, } = await octokit.request('GET /repos/{owner}/{repo}/compare/{base}...{head}', {
                owner: owner,
                repo: repo,
                base: commits[commits.length - 2].sha,
                head: commits[commits.length - 1].sha
            })
            // const { data: { files }, } = await octokit.repos.compareCommits({
            //     owner: owner,
            //     repo: repo,
            //     basehead: `${commits[commits.length - 2].sha}...${commits[commits.length - 1].sha}`,
            // })
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
        for (let i = 0; i < changedFiles.length; i++){
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
    }

    //프롬프트 생성 1단계
    async function generatePrompt(patch) {

        const prompt = `
        Answer me in Korean.
        Below is a code patch, please help me do a brief code review on it.
        Summarize what changes the code patch has.
        Any but risks and/or improvement suggestions are welcome:
        `
        return `${prompt}, ${patch}`;
    }

    // 프롬프트 만들고 응답 받아오는 2단계
    async function codeReview(patch) {
        if (!patch) { return ''; }
        const prompt = generatePrompt(patch);
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: prompt }],
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
    console.log(base)
    console.log(head)
    console.log(`${base}...${head}`)

    reviewPullRequest(owner, repo, pull_number, base, head);

})();
