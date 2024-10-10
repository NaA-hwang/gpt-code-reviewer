import fetch from "node-fetch";
import * as dotenv from 'dotenv';

(async () => {
    const { Octokit } = await import("@octokit/rest");
    const OpenAI = (await import("openai")).default;

    // // PR의 최신 커밋 SHA 가져오기
    // async function getCommitId(owner, repo, pull_number) {
    //     const { data: commits } = await octokit.pulls.listCommits({
    //         owner,
    //         repo,
    //         pull_number
    //     });

    //     // 최신 커밋의 SHA 반환
    //     return commits[commits.length - 1].sha;
    // }

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
        const { data } = await octokit.repos.compareCommits({
            owner: owner,
            repo: repo,
            basehead: `${ base }...${ head }`
        });
        let { files: changedFiles, commits } = data.data;
        if (commits.length >= 2) {
            const { data: { files }, } = await octokit.repos.compareCommits({
                owner: owner,
                repo: repo,
                base: commits[commits.length - 2].sha,
                head: commits[commits.length - 1].sha,
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
            }
            catch (e) {
                console.error(`review ${file.filename} failed`, e);
            }
        }
    }

    //프롬프트 생성 1단계
    async function generatePrompt(patch) {
        const full_prompt_as_backup = `
        You should answer in Korean.
        You are a strict and perfect code reviewer. You cannot tell any lies.
        Please evaluate the code added or changed through Pull Requests.
        There are two steps you need to follow:
            First, provide a numbered summary of the changes made in the code patch.
            Second, evaluate the code patch according to the evaluation criteria given below.

        According to the given evaluation criteria, if a code patch corresponds to any of the issues below, give the user a feedback.

        There are four evaluation criteria. If multiple issues correspond to a single criteria, you should address them in a detailed manner:
            - Feedback should describe what the issue is according to the evaluation criteria.
            - Relevant_Lines should be written as "[line_num]-[line_num]", indicating the range of lines where the issue occurs.
            - Suggested_Code should only include the revised code based on the feedback.

        If there are no issues, DO NOT SAY ANYTHING. In that case, your asnwer has to be empty.

        Evaluation criteria are:
        - Pre-condition_check: Check whether a function or method has the correct state or range of values for the variables needed to operate properly.
        - Runtime Error Check: Check code for potential runtime errors and identify other possible risks.
        - Security Issue: Check if the code uses modules with serious security flaws or contains security vulnerabilities.
        - Optimization: Check for optimization points in the code patch. If the code is deemed to have performance issues, recommend optimized code.

        Your answer should be in Korean.

        Code to review:
        ${block.lines.join('\n')}
        `;
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

    // // OpenAI API를 통해 코드 리뷰 생성
    // async function generateReview(block) {
    //     const prompt = `
    //     You should answer in Korean.
    //     Your answer should be in Korean.

    //     Code to review:
    //     ${block.lines.join('\n')}
    //     `;

    //     const response = await openai.chat.completions.create({
    //         model: "gpt-4",
    //         messages: [{ role: "system", content: prompt }],
    //         max_tokens: 1000,
    //         temperature: 0,
    //     });

    //     return response.choices[0].message.content;
    // }

    // // PR에 리뷰 게시
    // async function postReviewComment(owner, repo, pull_number, commit_id, file, start_position, review_body) {
    //     await octokit.pulls.createReviewComment({
    //         owner: owner,
    //         repo: repo,
    //         pull_number: pull_number,
    //         body: review_body,
    //         path: file,
    //         position: start_position,  // 첫 라인의 위치
    //         commit_id: commit_id  // 최신 커밋 SHA 추가
    //     });
    // }


    // 전체 리뷰 생성 및 게시 프로세스
    async function reviewPullRequest(owner, repo, pull_number, base, head) {
        try {
            runReview(owner, repo, pull_number, base, head) 

            console.log("Review comments posted successfully!");
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
