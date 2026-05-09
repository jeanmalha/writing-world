import os, json, uuid, boto3
from datetime import datetime, timezone, timedelta
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

ddb = boto3.resource('dynamodb')
lam = boto3.client('lambda')

TABLE         = os.environ['JOBS_TABLE']
WORLD_TABLE   = os.environ.get('WORLD_TABLE', '')
PROCESSOR_ARN = os.environ.get('PROCESSOR_ARN', '')
MODEL_ID      = os.environ['MODEL']
CHUNK_WORDS   = 2000


# ── API handler ──────────────────────────────────────────────────────────────

def handler(event, context):
    ctx    = event.get('requestContext', {}).get('http', {})
    method = ctx.get('method', '')
    path   = ctx.get('path', '').rstrip('/')

    if method == 'GET'  and path.endswith('/world'):
        return get_world(event)
    if method == 'PUT'  and path.endswith('/world'):
        return put_world(event)
    if method == 'POST' and path.endswith('/extract'):
        return start_job(event, 'extract')
    if method == 'GET'  and '/extract/' in path:
        return poll(path.split('/')[-1])
    if method == 'POST' and path.endswith('/analyze'):
        return start_job(event, 'analyze')
    if method == 'GET'  and '/analyze/' in path:
        return poll(path.split('/')[-1])
    return out(404, {'error': 'not found'})


def start_job(event, job_type):
    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return out(400, {'error': 'invalid JSON'})

    if job_type == 'extract':
        text = str(body.get('text', '')).strip()
        if not text:
            return out(400, {'error': 'text is required'})
        existing = body.get('existingEntities', [])
    else:
        existing = body.get('entities', [])
        if not existing:
            return out(400, {'error': 'entities is required'})
        text = None

    job_id = str(uuid.uuid4())
    ttl    = int((datetime.now(timezone.utc) + timedelta(hours=24)).timestamp())
    now    = datetime.now(timezone.utc).isoformat()

    item = {'jobId': job_id, 'jobType': job_type, 'status': 'processing',
            'startedAt': now, 'ttl': ttl}
    if text:
        item['text'] = text
    if existing:
        item['existing'] = json.dumps(existing)

    ddb.Table(TABLE).put_item(Item=item)
    lam.invoke(FunctionName=PROCESSOR_ARN, InvocationType='Event',
               Payload=json.dumps({'jobId': job_id, 'jobType': job_type}))

    return out(202, {'jobId': job_id, 'status': 'processing'})


def poll(job_id):
    item = ddb.Table(TABLE).get_item(Key={'jobId': job_id}).get('Item')
    if not item:
        return out(404, {'error': 'job not found'})

    status = item['status']
    if status == 'processing':
        started = datetime.fromisoformat(item.get('startedAt',
                  datetime.now(timezone.utc).isoformat()))
        if (datetime.now(timezone.utc) - started).total_seconds() > 720:
            status = 'error'

    resp = {'jobId': job_id, 'status': status,
            'jobType': item.get('jobType', 'extract')}
    if status == 'done':
        resp['result'] = json.loads(item.get('result', '{}'))
    elif status == 'error':
        resp['error'] = item.get('error', 'Processing timed out or failed')
    return out(200, resp)


# ── World persistence ─────────────────────────────────────────────────────────

def _user_id(event):
    try:
        return event['requestContext']['authorizer']['jwt']['claims']['sub']
    except (KeyError, TypeError):
        return None

def get_world(event):
    uid = _user_id(event)
    if not uid:
        return out(401, {'error': 'unauthorized'})
    item = ddb.Table(WORLD_TABLE).get_item(Key={'userId': uid}).get('Item')
    if not item:
        return out(404, {'error': 'no world found'})
    return out(200, {'data': json.loads(item['data']), 'updatedAt': item['updatedAt']})

def put_world(event):
    uid = _user_id(event)
    if not uid:
        return out(401, {'error': 'unauthorized'})
    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return out(400, {'error': 'invalid JSON'})
    world_data = body.get('data')
    if not world_data:
        return out(400, {'error': 'data is required'})
    now = datetime.now(timezone.utc).isoformat()
    ddb.Table(WORLD_TABLE).put_item(Item={
        'userId':    uid,
        'data':      json.dumps(world_data),
        'updatedAt': now,
    })
    return out(200, {'updatedAt': now})


# ── Async processor ──────────────────────────────────────────────────────────

def process(event, context):
    job_id   = event.get('jobId')
    job_type = event.get('jobType', 'extract')
    table    = ddb.Table(TABLE)
    item     = table.get_item(Key={'jobId': job_id}).get('Item')
    if not item:
        return

    try:
        existing = json.loads(item.get('existing', '[]'))
        if job_type == 'extract':
            result = run_extract_agent(item.get('text', ''), existing)
        else:
            result = run_analyze_agent(existing)

        table.update_item(
            Key={'jobId': job_id},
            UpdateExpression='SET #s = :s, #r = :r',
            ExpressionAttributeNames={'#s': 'status', '#r': 'result'},
            ExpressionAttributeValues={':s': 'done', ':r': json.dumps(result)},
        )
    except Exception as e:
        table.update_item(
            Key={'jobId': job_id},
            UpdateExpression='SET #s = :s, #e = :e',
            ExpressionAttributeNames={'#s': 'status', '#e': 'error'},
            ExpressionAttributeValues={':s': 'error', ':e': str(e)},
        )


# ── Extract agent ─────────────────────────────────────────────────────────────

def run_extract_agent(text: str, existing: list) -> dict:
    words  = text.split()
    state  = {
        'queue':   [' '.join(words[i:i+CHUNK_WORDS]) for i in range(0, len(words), CHUNK_WORDS)],
        'creates': [],
        'updates': [],
    }
    total = len(state['queue'])

    existing_ctx = ''
    if existing:
        lines = []
        for e in existing:
            extra = e.get('role') or e.get('locType') or e.get('date') or ''
            desc  = (e.get('description') or '')[:80]
            lines.append(
                f"  [{e['id']}] {e['type'].upper()}: {e['name']}"
                + (f" ({extra})" if extra else '')
                + (f" — {desc}" if desc else '')
            )
        existing_ctx = "EXISTING ENTITIES (disambiguate against these):\n" + "\n".join(lines) + "\n\n"

    @tool
    def get_next_chunk() -> str:
        """Return the next unprocessed text chunk. Returns NO_MORE_CHUNKS when done."""
        return state['queue'].pop(0) if state['queue'] else 'NO_MORE_CHUNKS'

    @tool
    def create_entity(entity_type: str, name: str, description: str,
                      role: str = '', loc_type: str = '',
                      date: str = '', importance: str = '') -> str:
        """Create a NEW entity not found in the existing entity list.

        Args:
            entity_type: character | location | faction | species | event | artifact | lore
            name: entity name
            description: description or notes
            role: characters only (e.g. Captain, Engineer)
            loc_type: locations only (e.g. Planet, Station, Ship)
            date: events only
            importance: events only — Critical | Major | Minor | Background
        """
        entry = {k: v for k, v in {
            'type': entity_type, 'name': name, 'description': description,
            'role': role, 'locType': loc_type, 'date': date, 'importance': importance,
        }.items() if v}
        state['creates'].append(entry)
        return f"Queued creation: {entity_type} '{name}'"

    @tool
    def update_entity(entity_id: str, field_updates: dict) -> str:
        """Update fields of an EXISTING entity from the entity list above.

        Args:
            entity_id: the [ID] from the existing entity list
            field_updates: dict of fields to update, e.g. {"description": "...", "status": "Active"}
        """
        state['updates'].append({'id': entity_id, 'changes': field_updates})
        return f"Queued update for {entity_id}"

    agent = Agent(
        model=BedrockModel(model_id=MODEL_ID),
        tools=[get_next_chunk, create_entity, update_entity],
        system_prompt=(
            "You are a literary analyst. Extract entities from novel text chunks. "
            "When an entity matches one from the EXISTING ENTITIES list, call update_entity. "
            "When it is genuinely new, call create_entity. "
            "Use get_next_chunk to retrieve text and repeat until NO_MORE_CHUNKS."
        ),
    )

    agent(f"{existing_ctx}Process the {total} text chunk(s). "
          "Call get_next_chunk, then create_entity or update_entity for each entity found.")

    return {'creates': _dedupe(state['creates']), 'updates': state['updates']}


# ── Analyze agent ─────────────────────────────────────────────────────────────

def run_analyze_agent(entities: list) -> dict:
    state = {'links': [], 'merges': []}

    lines = []
    for e in entities:
        existing_links = ', '.join(
            f"{l.get('targetId','')}({l.get('label','')})"
            for l in e.get('links', [])
        ) or 'none'
        extra = e.get('role') or e.get('locType') or ''
        desc  = (e.get('description') or '')[:100]
        lines.append(
            f"[{e['id']}] {e['type'].upper()}: {e['name']}"
            + (f" ({extra})" if extra else '')
            + (f" — {desc}" if desc else '')
            + f" | links: {existing_links}"
        )

    @tool
    def suggest_link(source_id: str, target_id: str, label: str, reason: str) -> str:
        """Suggest a new relationship link between two entities.

        Args:
            source_id: ID of the source entity
            target_id: ID of the target entity
            label: short directional label (e.g. 'commands', 'located in', 'member of')
            reason: one-line explanation
        """
        key = f"{source_id}→{target_id}"
        if not any(f"{l['sourceId']}→{l['targetId']}" == key for l in state['links']):
            state['links'].append({'sourceId': source_id, 'targetId': target_id,
                                   'label': label, 'reason': reason})
        return f"Suggested: {source_id} --[{label}]--> {target_id}"

    @tool
    def suggest_merge(keep_id: str, merge_id: str, reason: str) -> str:
        """Suggest merging two entities that appear to be the same thing.

        Args:
            keep_id: ID of the entity to keep (more complete / primary)
            merge_id: ID of the entity to discard (duplicate / alias)
            reason: explanation of why they are the same
        """
        state['merges'].append({'keepId': keep_id, 'mergeId': merge_id, 'reason': reason})
        return f"Suggested merge: keep {keep_id}, discard {merge_id}"

    agent = Agent(
        model=BedrockModel(model_id=MODEL_ID),
        tools=[suggest_link, suggest_merge],
        system_prompt=(
            "You are a literary analyst. Given a world's entity list, identify:\n"
            "1. Meaningful relationships not yet linked — call suggest_link\n"
            "2. Probable duplicate entities with different names — call suggest_merge\n"
            "Only suggest high-confidence items. Skip links that already exist."
        ),
    )

    agent(
        "Here are all entities in this novel world:\n\n"
        + "\n".join(lines)
        + "\n\nSuggest missing links and potential merges."
    )

    return {'links': state['links'], 'merges': state['merges']}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _dedupe(items: list) -> list:
    seen, result = set(), []
    for item in (items or []):
        key = str(item.get('name', '')).lower().strip()
        if key and key not in seen:
            seen.add(key)
            result.append(item)
    return result

def out(code: int, data: dict) -> dict:
    return {'statusCode': code, 'body': json.dumps(data)}
