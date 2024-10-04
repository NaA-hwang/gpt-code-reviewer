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
    });;

    // PR의 최신 커밋 SHA 가져오기
    async function getCommitId(owner, repo, pull_number) {
        const { data: commits } = await octokit.pulls.listCommits({
            owner,
            repo,
            pull_number
        });

        // 최신 커밋의 SHA 반환
        return commits[commits.length - 1].sha;
    }

    // PR의 diff 가져오기
    async function getDiff(owner, repo, pull_number) {
        const { data: files } = await octokit.pulls.listFiles({
            owner,
            repo,
            pull_number
        });

        let changes = [];
        files.forEach(file => {
            if (file.patch) {
                const patchLines = file.patch.split('\n');
                let lineNumber = 0;
                patchLines.forEach((line, index) => {
                    if (line.startsWith('+') && !line.startsWith('+++')) { // 추가된 코드 라인
                        changes.push({
                            file: file.filename,
                            position: index + 1, // 해당 라인의 위치
                            line: line
                        });
                    }
                });
            }
        });

        return changes;
    }

    // OpenAI API를 통해 코드 리뷰 생성
    async function generateReview(diff) {
        const prompt = `
        You should answer in Korean.
        You are a strict and perfect code reviewer. You cannot tell any lies.
        Please evaluate the code added or changed through Pull Requests.

        According to the given evaluation criteria, if a code patch corresponds to any of the issues below,

        There are four evaluation criteria. If multiple issues correspond to a single criteria , you should address them in a detailed manner:
            - Feedback should describe what the issue is according to the evaluation criteria.
            - Relevant_Lines should be written as "[line_num]-[line_num]", indicating the range of lines where the issue occurs.
            - Suggested_Code should only include the revised code based on the feedback.

        If there are no issues, return "No Issues Found".

        Evaluation criteria are:
        - Pre-condition_check
        - Runtime Error Check
        - Security Issue
        - Optimization

        Your answer should be in Korean.

        Code to review:
        ${diff}
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "system", content: prompt }],
            max_tokens: 1000,
            temperature: 0,
        });

        return response.choices[0].message.content;
    }

    // PR에 리뷰 게시
    async function postReviewComment(owner, repo, pull_number, file, position, review_body) {
        await octokit.pulls.createReviewComment({
            owner: owner,
            repo: repo,
            pull_number: pull_number,
            body: review_body,
            commit_id: commit_id,
            path: file,
            line: position,
            subject_type: 'line'
        });
    }


    // 전체 리뷰 생성 및 게시 프로세스
    async function reviewPullRequest(owner, repo, pull_number) {
        try {
            const commit_id = await getCommitId(owner, repo, pull_number); // 최신 커밋 SHA 가져오기
            const changes = await getDiff(owner, repo, pull_number);

            // 각 코드 블록별로 리뷰 생성 및 코멘트 게시
            for (const change of changes) {
                const review = await generateReview(change);
                await postReviewComment(owner, repo, pull_number, commit_id, change.file, change.position, review);
            }

            console.log("Review comments posted successfully!");
        } catch (error) {
            console.error("Error:", error);
        }
    }

    // 환경 변수로부터 프로젝트 정보 가져오기
    const owner = process.env.GITHUB_OWNER;  // GitHub 사용자 또는 조직 이름
    const repo = process.env.GITHUB_REPOSITORY_NAME;  // 리포지토리 이름
    const pull_number = process.env.GITHUB_PR_NUMBER;  // PR 번호

    reviewPullRequest(owner, repo, pull_number);

})();
