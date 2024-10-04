import fetch from "node-fetch";
import * as dotenv from 'dotenv';

(async () => {
    const { Octokit } = await import("@octokit/rest");
    const OpenAI = (await import("openai")).default;
    
    // dotenv 설정
    dotenv.config();

    // GitHub와 OpenAI API 설정
    const octokit = new Octokit({
        request: {
            fetch: fetch,
        }
    });

    const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
    });;

    // PR의 diff 가져오기
    async function getDiff(owner, repo, pull_number) {
        const { data: files } = await octokit.pulls.listFiles({
            owner,
            repo,
            pull_number
        });

        let diff = "";
        files.forEach(file => {
            if (file.patch) {
                diff += `File: ${file.filename}\n${file.patch}\n\n`;
            }
        });

        return diff;
    }

    // OpenAI API를 통해 코드 리뷰 생성
    async function generateReview(diff) {
        const prompt = `
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
    async function postReview(owner, repo, pull_number, review_body) {
        await octokit.pulls.createReview({
            owner,
            repo,
            pull_number,
            body: review_body,
            event: "COMMENT"
        });
    }

    // 전체 리뷰 생성 및 게시 프로세스
    async function reviewPullRequest(owner, repo, pull_number) {
        try {
            const diff = await getDiff(owner, repo, pull_number);
            const review = await generateReview(diff);
            await postReview(owner, repo, pull_number, review);
            console.log("Review posted successfully!");
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
