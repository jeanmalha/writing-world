import os, json, uuid, boto3
from datetime import datetime, timezone, timedelta
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

ddb     = boto3.resource('dynamodb')
lam     = boto3.client('lambda')
s3      = boto3.client('s3')
cognito = boto3.client('cognito-idp')

TABLE         = os.environ['JOBS_TABLE']
WORLD_TABLE   = os.environ.get('WORLD_TABLE', '')
PROCESSOR_ARN = os.environ.get('PROCESSOR_ARN', '')
PDF_BUCKET      = os.environ.get('PDF_BUCKET', '')
INTEREST_BUCKET = os.environ.get('INTEREST_BUCKET', '')
USAGE_TABLE     = os.environ.get('USAGE_TABLE', '')
USER_POOL_ID    = os.environ.get('USER_POOL_ID', '')
SIMPLE_MODEL  = os.environ.get('SIMPLE_MODEL',  'openai.gpt-oss-20b-1:0')
COMPLEX_MODEL = os.environ.get('COMPLEX_MODEL', 'global.anthropic.claude-sonnet-4-6')
DAILY_LIMIT   = int(os.environ.get('DAILY_TOKEN_LIMIT',   '0'))
WEEKLY_LIMIT  = int(os.environ.get('WEEKLY_TOKEN_LIMIT',  '0'))
MONTHLY_LIMIT = int(os.environ.get('MONTHLY_TOKEN_LIMIT', '0'))
CHUNK_WORDS   = 2000
PDF_CHUNK_PAGES = 5

def resolve_model(mode):
    return COMPLEX_MODEL if mode == 'complex' else SIMPLE_MODEL


# ── Admin helpers ────────────────────────────────────────────────────────────

def _is_admin(event):
    try:
        claims = event['requestContext']['authorizer']['jwt']['claims']
        groups = claims.get('cognito:groups', '')
        if not groups:
            return False
        if groups.startswith('['):
            return 'admins' in json.loads(groups)
        return 'admins' in groups.split(',')
    except Exception:
        return False


# ── Usage metering ────────────────────────────────────────────────────────────

def _add_usage(agent_result, totals):
    """Pull token counts from a Strands AgentResult into a running totals dict."""
    if totals is None:
        return
    try:
        acc = agent_result.metrics.accumulated_usage
        totals['input']  += acc.get('inputTokens', 0) or 0
        totals['output'] += acc.get('outputTokens', 0) or 0
    except Exception:
        pass


def _record_usage(user_id, input_tokens, output_tokens):
    if not USAGE_TABLE or not user_id:
        return
    total = input_tokens + output_tokens
    if not total:
        return
    try:
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        ttl   = int((datetime.now(timezone.utc) + timedelta(days=90)).timestamp())
        ddb.Table(USAGE_TABLE).update_item(
            Key={'userId': user_id, 'date': today},
            UpdateExpression='ADD inputTokens :i, outputTokens :o, totalTokens :t SET #ttl = :ttl',
            ExpressionAttributeNames={'#ttl': 'ttl'},
            ExpressionAttributeValues={':i': input_tokens, ':o': output_tokens, ':t': total, ':ttl': ttl},
        )
    except Exception as e:
        print(f'Usage recording failed: {e}')


def _check_usage_limit(user_id):
    """Returns (ok, reason). ok=False means a limit is exceeded."""
    if not USAGE_TABLE or not user_id:
        return True, ''
    if not any([DAILY_LIMIT, WEEKLY_LIMIT, MONTHLY_LIMIT]):
        return True, ''
    try:
        today = datetime.now(timezone.utc)
        dates = [(today - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(30)]
        resp  = ddb.batch_get_item(RequestItems={
            USAGE_TABLE: {'Keys': [{'userId': user_id, 'date': d} for d in dates]}
        })
        rows    = resp.get('Responses', {}).get(USAGE_TABLE, [])
        by_date = {r['date']: int(r.get('totalTokens', 0)) for r in rows}

        if DAILY_LIMIT:
            day = by_date.get(today.strftime('%Y-%m-%d'), 0)
            if day >= DAILY_LIMIT:
                return False, f'Daily token limit reached ({day:,}/{DAILY_LIMIT:,})'

        if WEEKLY_LIMIT:
            week = sum(by_date.get((today - timedelta(days=i)).strftime('%Y-%m-%d'), 0) for i in range(7))
            if week >= WEEKLY_LIMIT:
                return False, f'Weekly token limit reached ({week:,}/{WEEKLY_LIMIT:,})'

        if MONTHLY_LIMIT:
            month = sum(by_date.get((today - timedelta(days=i)).strftime('%Y-%m-%d'), 0) for i in range(30))
            if month >= MONTHLY_LIMIT:
                return False, f'Monthly token limit reached ({month:,}/{MONTHLY_LIMIT:,})'

        return True, ''
    except Exception as e:
        print(f'Usage limit check failed: {e}')
        return True, ''  # fail open


# ── API handler ──────────────────────────────────────────────────────────────

def handler(event, context):
    ctx    = event.get('requestContext', {}).get('http', {})
    method = ctx.get('method', '')
    path   = ctx.get('path', '').rstrip('/')

    if method == 'POST' and path.endswith('/interest'):
        return handle_interest(event)
    if method == 'GET'  and path.endswith('/world'):
        return get_world(event)
    if method == 'PUT'  and path.endswith('/world'):
        return put_world(event)
    if method == 'POST' and path.endswith('/extract-pdf'):
        return start_job(event, 'extract-pdf')
    if method == 'GET'  and '/extract-pdf/' in path:
        return poll(path.split('/')[-1])
    if method == 'POST' and path.endswith('/extract'):
        return start_job(event, 'extract')
    if method == 'GET'  and '/extract/' in path:
        return poll(path.split('/')[-1])
    if method == 'POST' and path.endswith('/analyze'):
        return start_job(event, 'analyze')
    if method == 'GET'  and '/analyze/' in path:
        return poll(path.split('/')[-1])
    if method == 'GET'  and path.endswith('/admin/users'):
        return admin_list_users(event)
    if method == 'POST' and path.endswith('/admin/users'):
        return admin_create_user(event)
    if method == 'GET'  and path.endswith('/admin/status'):
        return admin_status(event)
    if method == 'GET'  and path.endswith('/admin/usage'):
        return admin_usage(event)
    return out(404, {'error': 'not found'})


def start_job(event, job_type):
    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return out(400, {'error': 'invalid JSON'})

    user_id = _user_id(event)
    ok, reason = _check_usage_limit(user_id)
    if not ok:
        return out(429, {'error': reason})

    job_id = str(uuid.uuid4())
    ttl    = int((datetime.now(timezone.utc) + timedelta(hours=24)).timestamp())
    now    = datetime.now(timezone.utc).isoformat()
    mode   = body.get('model', 'simple')

    item = {'jobId': job_id, 'jobType': job_type, 'status': 'processing',
            'modelMode': mode, 'startedAt': now, 'ttl': ttl}

    if user_id:
        item['userId'] = user_id

    if job_type == 'extract':
        text = str(body.get('text', '')).strip()
        if not text:
            return out(400, {'error': 'text is required'})
        existing = body.get('existingEntities', [])
        item['text'] = text
        if existing:
            item['existing'] = json.dumps(existing)

    elif job_type == 'extract-pdf':
        pages = body.get('pages', [])
        if not pages:
            return out(400, {'error': 'pages is required'})
        existing = body.get('existingEntities', [])
        s3_key = f'pdf-jobs/{job_id}.json'
        s3.put_object(Bucket=PDF_BUCKET, Key=s3_key,
                      Body=json.dumps(pages),
                      ContentType='application/json')
        item['s3Key'] = s3_key
        item['pageCount'] = len(pages)
        if existing:
            item['existing'] = json.dumps(existing)

    else:  # analyze
        existing = body.get('entities', [])
        if not existing:
            return out(400, {'error': 'entities is required'})
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


# ── Admin routes ──────────────────────────────────────────────────────────────

def admin_list_users(event):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})
    if not USER_POOL_ID:
        return out(500, {'error': 'USER_POOL_ID not configured'})

    users, pt = [], None
    while True:
        kwargs = {'UserPoolId': USER_POOL_ID, 'Limit': 60}
        if pt:
            kwargs['PaginationToken'] = pt
        resp = cognito.list_users(**kwargs)
        for u in resp.get('Users', []):
            attrs = {a['Name']: a['Value'] for a in u.get('Attributes', [])}
            users.append({
                'sub':     attrs.get('sub', ''),
                'email':   attrs.get('email', ''),
                'status':  u.get('UserStatus', ''),
                'enabled': u.get('Enabled', True),
                'created': u['UserCreateDate'].isoformat() if u.get('UserCreateDate') else '',
            })
        pt = resp.get('PaginationToken')
        if not pt:
            break

    return out(200, {'users': users})


def admin_create_user(event):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})
    if not USER_POOL_ID:
        return out(500, {'error': 'USER_POOL_ID not configured'})

    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return out(400, {'error': 'invalid JSON'})

    email = str(body.get('email', '')).strip()
    if not email:
        return out(400, {'error': 'email is required'})

    try:
        cognito.admin_create_user(
            UserPoolId=USER_POOL_ID,
            Username=email,
            UserAttributes=[
                {'Name': 'email',          'Value': email},
                {'Name': 'email_verified', 'Value': 'true'},
            ],
            DesiredDeliveryMediums=['EMAIL'],
        )
        return out(200, {'ok': True, 'email': email})
    except cognito.exceptions.UsernameExistsException:
        return out(409, {'error': 'User already exists'})
    except Exception as e:
        return out(500, {'error': str(e)})


def admin_status(event):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})

    # Job counts (table has 24h TTL so this reflects recent activity)
    job_counts = {'processing': 0, 'done': 0, 'error': 0}
    try:
        resp = ddb.Table(TABLE).scan(
            FilterExpression='#s IN (:p, :d, :e)',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':p': 'processing', ':d': 'done', ':e': 'error'},
        )
        for j in resp.get('Items', []):
            s = j.get('status', '')
            if s in job_counts:
                job_counts[s] += 1
    except Exception:
        pass

    # User count (paginate Cognito, cap at 1000)
    user_count = 0
    try:
        pt = None
        while True:
            kwargs = {'UserPoolId': USER_POOL_ID, 'Limit': 60}
            if pt:
                kwargs['PaginationToken'] = pt
            resp = cognito.list_users(**kwargs)
            user_count += len(resp.get('Users', []))
            pt = resp.get('PaginationToken')
            if not pt or user_count >= 1000:
                break
    except Exception:
        user_count = -1

    return out(200, {
        'jobs': job_counts,
        'userCount': user_count,
        'config': {
            'simpleModel':  SIMPLE_MODEL,
            'complexModel': COMPLEX_MODEL,
            'dailyLimit':   DAILY_LIMIT,
            'weeklyLimit':  WEEKLY_LIMIT,
            'monthlyLimit': MONTHLY_LIMIT,
        },
    })


def admin_usage(event):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})
    if not USAGE_TABLE:
        return out(200, {'rows': []})

    try:
        today = datetime.now(timezone.utc)
        resp  = ddb.Table(USAGE_TABLE).scan()
        rows  = resp.get('Items', [])

        by_user = {}
        for row in rows:
            uid  = row.get('userId', '')
            date = row.get('date', '')
            tok  = int(row.get('totalTokens', 0))
            if uid not in by_user:
                by_user[uid] = {}
            by_user[uid][date] = tok

        result = []
        for uid, by_date in by_user.items():
            d1  = by_date.get(today.strftime('%Y-%m-%d'), 0)
            d7  = sum(by_date.get((today - timedelta(days=i)).strftime('%Y-%m-%d'), 0) for i in range(7))
            d30 = sum(by_date.get((today - timedelta(days=i)).strftime('%Y-%m-%d'), 0) for i in range(30))
            result.append({'userId': uid, 'tokens1d': d1, 'tokens7d': d7, 'tokens30d': d30})

        result.sort(key=lambda r: r['tokens30d'], reverse=True)
        return out(200, {'rows': result})
    except Exception as e:
        return out(500, {'error': str(e)})


# ── Interest form ────────────────────────────────────────────────────────────

def handle_interest(event):
    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return out(400, {'error': 'invalid JSON'})

    email = str(body.get('email', '')).strip()[:320]
    if not email:
        return out(400, {'error': 'email is required'})

    name = str(body.get('name', '')).strip()[:200]
    sub  = bool(body.get('subscriptionInterest', False))
    now  = datetime.now(timezone.utc)

    record = {
        'timestamp':            now.isoformat(),
        'name':                 name,
        'email':                email,
        'subscriptionInterest': sub,
    }

    if INTEREST_BUCKET:
        key = f"submissions/{now.strftime('%Y/%m/%d')}/{uuid.uuid4()}.json"
        s3.put_object(
            Bucket=INTEREST_BUCKET,
            Key=key,
            Body=json.dumps(record, indent=2),
            ContentType='application/json',
        )

    return out(200, {'ok': True})


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

    usage = {'input': 0, 'output': 0}

    try:
        existing  = json.loads(item.get('existing', '[]'))
        model_id  = resolve_model(item.get('modelMode', 'simple'))
        user_id   = item.get('userId')

        if job_type == 'extract':
            result = run_extract_agent(item.get('text', ''), existing, model_id, usage)
        elif job_type == 'extract-pdf':
            s3_key = item.get('s3Key', '')
            obj    = s3.get_object(Bucket=PDF_BUCKET, Key=s3_key)
            pages  = json.loads(obj['Body'].read())
            result = run_extract_pdf_agent(pages, existing, model_id, usage)
        else:
            result = run_analyze_agent(existing, model_id, usage)

        table.update_item(
            Key={'jobId': job_id},
            UpdateExpression='SET #s = :s, #r = :r',
            ExpressionAttributeNames={'#s': 'status', '#r': 'result'},
            ExpressionAttributeValues={':s': 'done', ':r': json.dumps(result)},
        )

        _record_usage(user_id, usage['input'], usage['output'])

    except Exception as e:
        table.update_item(
            Key={'jobId': job_id},
            UpdateExpression='SET #s = :s, #e = :e',
            ExpressionAttributeNames={'#s': 'status', '#e': 'error'},
            ExpressionAttributeValues={':s': 'error', ':e': str(e)},
        )


# ── PDF orchestrator agent ────────────────────────────────────────────────────

def run_extract_pdf_agent(pages: list, existing: list, model_id: str, usage: dict = None) -> dict:
    """Orchestrator: splits pages into PDF_CHUNK_PAGES-page chunks, runs one sub-agent per chunk."""

    chunks = []
    for i in range(0, len(pages), PDF_CHUNK_PAGES):
        chunk_pages = pages[i:i + PDF_CHUNK_PAGES]
        text = '\n\n'.join(
            f'[Page {i + j + 1}]\n{chunk_pages[j]}'
            for j in range(len(chunk_pages))
        )
        chunks.append({
            'index': len(chunks),
            'start': i + 1,
            'end':   i + len(chunk_pages),
            'text':  text,
        })

    state = {'creates': [], 'updates': [], 'links': [], 'done': set()}

    @tool
    def process_chunk(chunk_index: int) -> str:
        """Run a literary analysis sub-agent on a 5-page chunk of the novel.

        Args:
            chunk_index: 0-based index of the chunk to process
        """
        if chunk_index in state['done']:
            return f"Chunk {chunk_index} already processed."
        if chunk_index < 0 or chunk_index >= len(chunks):
            return f"Invalid index {chunk_index}. Valid range: 0–{len(chunks)-1}."

        chunk      = chunks[chunk_index]
        sub_existing = existing + state['creates']
        result     = run_extract_agent(chunk['text'], sub_existing, model_id, usage)

        state['creates'].extend(result.get('creates', []))
        state['updates'].extend(result.get('updates', []))
        state['links'].extend(result.get('links', []))
        state['done'].add(chunk_index)

        n_c = len(result.get('creates', []))
        n_l = len(result.get('links', []))
        return f"Pages {chunk['start']}–{chunk['end']}: {n_c} new entities, {n_l} links."

    @tool
    def finalize() -> str:
        """Deduplicate all results after all chunks are processed. Call exactly once."""
        state['creates'] = _dedupe(state['creates'])
        return (f"Finalized: {len(state['creates'])} unique entities, "
                f"{len(state['updates'])} updates, {len(state['links'])} links.")

    existing_ctx = ''
    if existing:
        lines = [
            f"  [{e['id']}] {e['type'].upper()}: {e['name']}"
            + (f" ({e.get('role') or e.get('locType') or ''})" if (e.get('role') or e.get('locType')) else '')
            for e in existing
        ]
        existing_ctx = "EXISTING ENTITIES (disambiguate against these):\n" + "\n".join(lines) + "\n\n"

    chunk_list = "\n".join(f"  [{c['index']}] pages {c['start']}–{c['end']}" for c in chunks)

    agent = Agent(
        model=BedrockModel(model_id=model_id),
        tools=[process_chunk, finalize],
        system_prompt=(
            "You are an orchestrator for literary analysis of a full novel.\n\n"
            "TASK: Process every chunk in order by calling process_chunk(chunk_index). "
            "Each call launches a dedicated sub-agent that extracts characters, locations, "
            "events, artifacts, and relationships from those pages. "
            "Process chunks sequentially (0, 1, 2, …) so each sub-agent can see entities "
            "found in earlier chunks and avoid duplicates.\n\n"
            "After ALL chunks are processed, call finalize() exactly once to deduplicate "
            "the combined results and produce the final output."
        ),
    )

    result = agent(
        f"{existing_ctx}"
        f"Novel split into {len(chunks)} chunk(s):\n{chunk_list}\n\n"
        "Process all chunks in order, then finalize."
    )
    _add_usage(result, usage)

    return {
        'creates': _dedupe(state['creates']),
        'updates': state['updates'],
        'links':   state['links'],
    }


# ── Extract agent ─────────────────────────────────────────────────────────────

def run_extract_agent(text: str, existing: list, model_id: str, usage: dict = None) -> dict:
    words  = text.split()
    state  = {
        'queue':   [' '.join(words[i:i+CHUNK_WORDS]) for i in range(0, len(words), CHUNK_WORDS)],
        'creates': [],
        'updates': [],
        'links':   [],
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
                      date: str = '', importance: str = '',
                      gender: str = '', skin_tone: str = '',
                      hair_style: str = '', hair_color: str = '',
                      eye_color: str = '') -> str:
        """Create a NEW entity not found in the existing entity list.

        Args:
            entity_type: character | location | faction | species | event | artifact | lore
            name: entity name
            description: description or notes
            role: characters only (e.g. Captain, Engineer)
            loc_type: locations only (e.g. Planet, Station, Ship)
            date: events only
            importance: events only — Critical | Major | Minor | Background
            gender: characters only — Female | Male | Non-binary
            skin_tone: characters only — Very fair | Fair | Light | Medium | Olive | Brown | Dark | Very dark
            hair_style: characters only — Bald | Cropped | Short | Medium | Long | Very long
            hair_color: characters only — Black | Dark brown | Brown | Light brown | Blonde | Auburn | Red | Gray | White
            eye_color: characters only — Dark brown | Brown | Hazel | Amber | Green | Blue | Light blue | Gray
        """
        entry = {k: v for k, v in {
            'type': entity_type, 'name': name, 'description': description,
            'role': role, 'locType': loc_type, 'date': date, 'importance': importance,
            'gender': gender, 'skinTone': skin_tone,
            'hairStyle': hair_style, 'hairColor': hair_color, 'eyeColor': eye_color,
        }.items() if v}
        state['creates'].append(entry)
        return f"Queued creation: {entity_type} '{name}'"

    @tool
    def update_entity(entity_id: str, field_updates: dict) -> str:
        """Update fields of an EXISTING entity from the entity list above.

        Args:
            entity_id: the [ID] from the existing entity list
            field_updates: dict of fields to update — any entity field including
                           gender, skinTone, hairStyle, hairColor, eyeColor for characters
        """
        state['updates'].append({'id': entity_id, 'changes': field_updates})
        return f"Queued update for {entity_id}"

    @tool
    def create_link(source_name: str, target_name: str, label: str) -> str:
        """Record a relationship between two entities (referenced by name).
        Call this whenever the text describes a connection between entities.

        Args:
            source_name: exact name of the source entity
            target_name: exact name of the target entity
            label: short directional label (e.g. 'commands', 'member of',
                   'located in', 'created by', 'participated in', 'allied with')
        """
        state['links'].append({'sourceName': source_name, 'targetName': target_name, 'label': label})
        return f"Linked: '{source_name}' --[{label}]--> '{target_name}'"

    agent = Agent(
        model=BedrockModel(model_id=model_id),
        tools=[get_next_chunk, create_entity, update_entity, create_link],
        system_prompt=(
            "You are a literary analyst extracting structured data from novel text.\n\n"
            "ENTITIES: Call create_entity for every named character, location, faction, species, "
            "event, or artifact. If it matches an existing entity, call update_entity instead.\n\n"
            "PHYSICAL TRAITS: For characters, extract appearance from the text when mentioned. "
            "Example: 'her dark brown skin and cropped silver hair' → skinTone='Brown', "
            "hairColor='Gray', hairStyle='Cropped'. "
            "Example: 'the tall man's blue eyes narrowed' → eyeColor='Blue'.\n\n"
            "RELATIONSHIPS: Call create_link for every relationship mentioned in the text. "
            "Example: 'Captain Reyes commanded the Argo' → create_link('Captain Reyes','Argo','commands'). "
            "Example: 'Mira was a member of the Veil faction' → create_link('Mira','Veil','member of'). "
            "Example: 'The battle of Kepler Station' → create_link('Battle of Kepler','Kepler Station','took place at').\n\n"
            "Process all chunks with get_next_chunk before finishing."
        ),
    )

    result = agent(f"{existing_ctx}Process the {total} text chunk(s). "
                   "Call get_next_chunk, then create_entity or update_entity for each entity found.")
    _add_usage(result, usage)

    return {
        'creates': _dedupe(state['creates']),
        'updates': state['updates'],
        'links':   state['links'],
    }


# ── Analyze agent ─────────────────────────────────────────────────────────────

def run_analyze_agent(entities: list, model_id: str, usage: dict = None) -> dict:
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
        model=BedrockModel(model_id=model_id),
        tools=[suggest_link, suggest_merge],
        system_prompt=(
            "You are a literary analyst. Given a list of novel entities, suggest:\n\n"
            "MISSING LINKS: Relationships that should exist but aren't recorded. "
            "Example: a character whose role is 'Captain' probably commands a ship entity → "
            "suggest_link(captain_id, ship_id, 'commands'). "
            "Example: a character from a named faction → suggest_link(char_id, faction_id, 'member of'). "
            "Example: an event at a named location → suggest_link(event_id, location_id, 'took place at').\n\n"
            "DUPLICATES: Entities that are likely the same thing with different names. "
            "Example: 'Dr Chen' and 'Doctor Chen' are the same person → suggest_merge(keep_id, dupe_id, reason). "
            "Example: 'New Shanghai' and 'New Shanghai Colony' → suggest_merge.\n\n"
            "Only suggest high-confidence items. Skip links that already exist (shown after 'links:')."
        ),
    )

    result = agent(
        "Here are all entities in this novel world:\n\n"
        + "\n".join(lines)
        + "\n\nSuggest missing links and potential merges."
    )
    _add_usage(result, usage)

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
