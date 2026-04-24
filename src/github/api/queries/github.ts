// GraphQL queries for GitHub data

export const PR_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        title
        body
        author {
          login
        }
        baseRefName
        headRefName
        headRefOid
        isCrossRepository
        headRepository {
          owner {
            login
          }
          name
        }
        createdAt
        updatedAt
        lastEditedAt
        additions
        deletions
        state
        labels(first: 1) {
          nodes {
            name
          }
        }
        commits(first: 100) {
          totalCount
          nodes {
            commit {
              oid
              message
              author {
                name
                email
              }
            }
          }
        }
        files(first: 100) {
          nodes {
            path
            additions
            deletions
            changeType
          }
        }
        comments(first: 100) {
          nodes {
            id
            databaseId
            body
            author {
              login
            }
            createdAt
            updatedAt
            lastEditedAt
            isMinimized
          }
        }
        reviews(first: 100) {
          nodes {
            id
            databaseId
            author {
              login
            }
            body
            state
            submittedAt
            updatedAt
            lastEditedAt
            comments(first: 100) {
              nodes {
                id
                databaseId
                body
                path
                line
                author {
                  login
                }
                createdAt
                updatedAt
                lastEditedAt
                isMinimized
              }
            }
          }
        }
        closingIssuesReferences(first: 10) {
          nodes {
            number
            title
            body
            author {
              login
            }
            createdAt
            updatedAt
            lastEditedAt
            state
            comments(first: 50) {
              nodes {
                id
                databaseId
                body
                author {
                  login
                }
                createdAt
                updatedAt
                lastEditedAt
                isMinimized
              }
            }
          }
        }
      }
    }
  }
`;

export const ISSUE_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        title
        body
        author {
          login
        }
        createdAt
        updatedAt
        lastEditedAt
        state
        labels(first: 1) {
          nodes {
            name
          }
        }
        comments(first: 100) {
          nodes {
            id
            databaseId
            body
            author {
              login
            }
            createdAt
            updatedAt
            lastEditedAt
            isMinimized
          }
        }
        timelineItems(first: 25, itemTypes: [CROSS_REFERENCED_EVENT]) {
          nodes {
            ... on CrossReferencedEvent {
              source {
                ... on PullRequest {
                  number
                  title
                  body
                  author {
                    login
                  }
                  state
                  baseRefName
                  headRefName
                  additions
                  deletions
                  createdAt
                  comments(first: 25) {
                    nodes {
                      id
                      databaseId
                      body
                      author {
                        login
                      }
                      createdAt
                      updatedAt
                      lastEditedAt
                      isMinimized
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const USER_QUERY = `
  query($login: String!) {
    user(login: $login) {
      name
    }
  }
`;
