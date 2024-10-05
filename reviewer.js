    import fetch from "node-fetch";
    import * as dotenv from 'dotenv';

    (async () => {
        const { Octokit } = await import("@octokit/rest");
        const OpenAI = (await import("openai")).default;

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

        // 두 커밋 간의 변경 사항 가져오기 (compareCommits 사용)
        async function getChanges(owner, repo, base, head) {
            const { data } = await octokit.repos.compareCommits({
                owner,
                repo,
                base,
                head
            });

            let changes = [];
            data.files.forEach(file => {
                if (file.patch) {
                    const patchLines = file.patch.split('\n');
                    let currentBlock = null;

                    patchLines.forEach((line, index) => {
                        if (line.startsWith('+') && !line.startsWith('+++')) {
                            // 새 블록 시작
                            if (!currentBlock) {
                                currentBlock = {
                                    file: file.filename,
                                    start_position: index + 1, // 첫 라인의 위치
                                    lines: []
                                };
                            }
                            currentBlock.lines.push(line);  // 블록에 라인 추가
                        } else {
                            // 연속된 + 라인 끝, 블록을 저장하고 초기화
                            if (currentBlock) {
                                currentBlock.end_position = index;  // 마지막 라인의 위치
                                changes.push(currentBlock);
                                currentBlock = null;
                            }
                        }
                    });

                    // 마지막 블록 처리
                    if (currentBlock) {
                        currentBlock.end_position = patchLines.length;
                        changes.push(currentBlock);
                    }
                }
            });

            return changes;
        }

        // OpenAI API를 통해 코드 리뷰 생성
        async function generateReview(block) {
            const prompt = `
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

            const response = await openai.chat.completions.create({
                model: "gpt-4",
                messages: [{ role: "system", content: prompt }],
                max_tokens: 1000,
                temperature: 0,
            });

            return response.choices[0].message.content;
        }

        // PR에 리뷰 게시
        async function postReviewComment(owner, repo, pull_number, commit_id, file, start_position, review_body) {
            await octokit.pulls.createReviewComment({
                owner: owner,
                repo: repo,
                pull_number: pull_number,
                body: review_body,
                path: file,
                position: start_position,  // 첫 라인의 위치
                commit_id: commit_id  // 최신 커밋 SHA 추가
            });
        }


        // 전체 리뷰 생성 및 게시 프로세스
        async function reviewPullRequest(owner, repo, pull_number, base, head) {
            try {
                const commit_id = await getCommitId(owner, repo, head); // 최신 커밋 SHA 가져오기
                const changes = await getChanges(owner, repo, base, head);  // 두 커밋 간 차이 가져오기

                // 각 블록별로 리뷰 생성 및 코멘트 게시
                for (const block of changes) {
                    const review = await generateReview(block); // 블록 자체 전달
                    if (review) {
                        await postReviewComment(owner, repo, pull_number, commit_id, block.file, block.start_position, review);
                    }
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
        const base = process.env.GITHUB_BASE_COMMIT;  // 비교할 기준 커밋
        const head = process.env.GITHUB_HEAD_COMMIT;  // 비교할 최신 커밋

        reviewPullRequest(owner, repo, pull_number, base, head);

    })();
