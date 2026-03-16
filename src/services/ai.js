const logger = require('../logger');

async function generateOrgPrompts(orgName, guidance = '') {
    if (process.env.MOCK_AI === 'true') {
        logger.info({ msg: 'Mock AI mode — returning sample prompts', org: orgName });
        return [
            { text: `Draft a briefing memo summarizing ${orgName}'s top priorities for the quarter using Copilot in Word.`, category: 'Writing', app: 'Word' },
            { text: `Analyze our budget data and highlight variances over 10% using Copilot in Excel.`, category: 'Analysis', app: 'Excel' },
            { text: `Summarize the last 30 days of emails related to ${orgName} policy updates using Copilot in Outlook.`, category: 'Communication', app: 'Outlook' },
            { text: `Create a status-update presentation for leadership covering milestones and risks using Copilot in PowerPoint.`, category: 'Planning', app: 'PowerPoint' },
            { text: `Generate meeting notes and action items from our last all-hands using Copilot in Teams.`, category: 'Communication', app: 'Teams' },
            { text: `Build a project tracking template for ${orgName} tasks with automated status formulas using Copilot in Excel.`, category: 'Data', app: 'Excel' },
            { text: `Write a plain-language summary of the latest regulatory guidance relevant to ${orgName} using Copilot in Word.`, category: 'Writing', app: 'Word' },
            { text: `Identify recurring themes in employee feedback survey responses for ${orgName} using Copilot.`, category: 'Analysis', app: 'General' },
        ];
    }

    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_KEY;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
    if (!endpoint) throw new Error('Missing AZURE_OPENAI_ENDPOINT environment variable');
    if (!apiKey) throw new Error('Missing AZURE_OPENAI_KEY environment variable');
    if (!deployment) throw new Error('Missing AZURE_OPENAI_DEPLOYMENT environment variable');

    const endpointUrl = endpoint.replace(/\/+$/, '');

    const guidanceClause = guidance.trim()
        ? `\n\nAdditional context from the event organizer:\n${guidance.trim()}`
        : '';

    const response = await fetch(`${endpointUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey
        },
        body: JSON.stringify({
            messages: [
                {
                    role: 'system',
                    content: `You are an expert at creating Microsoft Copilot prompts for government agencies. Generate practical, role-specific prompts that would help employees be more productive.

For each prompt, specify:
- text: The actual prompt text
- category: The work category (e.g., "Writing", "Analysis", "Communication", "Data", "Planning")
- app: The Microsoft app (Word, Excel, PowerPoint, Outlook, Teams, or General)

Return a JSON array of 8-10 prompts.`
                },
                {
                    role: 'user',
                    content: `Generate Microsoft Copilot prompts specifically tailored for employees at ${orgName}. Consider their mission, typical work tasks, and how AI could help them be more productive.${guidanceClause}

Return ONLY a valid JSON array like:
[{"text": "prompt text here", "category": "Writing", "app": "Word"}, ...]`
                }
            ],
            max_completion_tokens: 2000,
            
        })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
        throw new Error(data.error?.message || 'API request failed');
    }
    
    const content = data.choices[0].message.content;
    
    let jsonStr = content;
    if (content.includes('```')) {
        jsonStr = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }
    
    return JSON.parse(jsonStr);
}

module.exports = { generateOrgPrompts };
