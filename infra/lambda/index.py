import os, json, uuid, boto3
from datetime import datetime, timezone, timedelta
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

ddb     = boto3.resource('dynamodb')
lam     = boto3.client('lambda')
s3      = boto3.client('s3')
cognito = boto3.client('cognito-idp')
athena  = boto3.client('athena')

TABLE         = os.environ['JOBS_TABLE']
WORLD_TABLE   = os.environ.get('WORLD_TABLE', '')
PROCESSOR_ARN = os.environ.get('PROCESSOR_ARN', '')
PDF_BUCKET      = os.environ.get('PDF_BUCKET', '')
INTEREST_BUCKET = os.environ.get('INTEREST_BUCKET', '')
USAGE_TABLE          = os.environ.get('USAGE_TABLE', '')
TIERS_TABLE          = os.environ.get('TIERS_TABLE', '')
USER_POOL_ID         = os.environ.get('USER_POOL_ID', '')
ATHENA_RESULTS_BUCKET = os.environ.get('ATHENA_RESULTS_BUCKET', '')
FEATURES_TABLE        = os.environ.get('FEATURES_TABLE', '')
VISITS_TABLE          = os.environ.get('VISITS_TABLE', '')
SIMPLE_MODEL  = os.environ.get('SIMPLE_MODEL',  'openai.gpt-oss-20b-1:0')
COMPLEX_MODEL = os.environ.get('COMPLEX_MODEL', 'global.anthropic.claude-sonnet-4-6')
CHUNK_WORDS     = 2000
PDF_CHUNK_PAGES = 5

def resolve_model(mode):
    return COMPLEX_MODEL if mode == 'complex' else SIMPLE_MODEL


# ── Tier system ───────────────────────────────────────────────────────────────

TIER_PRIORITY = {'uncharted': 3, 'trailblazer': 2, 'explorer': 1}

FEATURE_DEFAULTS = {
    'assistant': {
        'flagId':      'assistant',
        'label':       'Lore Assistant',
        'description': 'In-browser AI chat (experimental, client-side model)',
        'enabled':     True,
        'model':       '360M',  # '360M' | '1.7B'
    },
}

TIER_DEFAULTS = {
    'explorer':    {'model': 'simple',  'dailyLimit': 50_000,    'weeklyLimit': 200_000,   'monthlyLimit': 500_000},
    'trailblazer': {'model': 'complex', 'dailyLimit': 200_000,   'weeklyLimit': 1_000_000, 'monthlyLimit': 3_000_000},
    'uncharted':   {'model': 'complex', 'dailyLimit': 0,         'weeklyLimit': 0,         'monthlyLimit': 0},
}

TIER_LABELS = {
    'explorer':    'Explorer',
    'trailblazer': 'Trailblazer',
    'uncharted':   'Uncharted',
}

def _parse_groups(claims):
    groups = claims.get('cognito:groups')
    if not groups:
        return []
    groups_str = str(groups).strip()
    if groups_str.startswith('['):
        try:
            return json.loads(groups_str)
        except Exception:
            groups_str = groups_str.strip('[]')
    return [g.strip() for g in groups_str.replace(' ', ',').split(',') if g.strip()]

def _is_admin(event):
    try:
        claims = event['requestContext']['authorizer']['jwt']['claims']
        return 'admins' in _parse_groups(claims)
    except Exception:
        return False

def _get_user_tier(event):
    """Return the highest-priority tier the user belongs to, defaulting to explorer."""
    try:
        claims = event['requestContext']['authorizer']['jwt']['claims']
        groups = _parse_groups(claims)
        best, best_p = 'explorer', 0
        for g in groups:
            p = TIER_PRIORITY.get(g, 0)
            if p > best_p:
                best, best_p = g, p
        return best
    except Exception:
        return 'explorer'

def _get_tier_config(tier_id):
    defaults = TIER_DEFAULTS.get(tier_id, TIER_DEFAULTS['explorer'])
    if not TIERS_TABLE:
        return dict(defaults)
    try:
        item = ddb.Table(TIERS_TABLE).get_item(Key={'tierId': tier_id}).get('Item')
        if not item:
            return dict(defaults)
        return {
            'model':        item.get('model',        defaults['model']),
            'dailyLimit':   int(item.get('dailyLimit',   defaults['dailyLimit'])),
            'weeklyLimit':  int(item.get('weeklyLimit',  defaults['weeklyLimit'])),
            'monthlyLimit': int(item.get('monthlyLimit', defaults['monthlyLimit'])),
        }
    except Exception:
        return dict(defaults)


# ── Usage metering ────────────────────────────────────────────────────────────

def _add_usage(agent_result, totals):
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

def _check_usage_limit(user_id, tier_config):
    daily   = tier_config.get('dailyLimit', 0)
    weekly  = tier_config.get('weeklyLimit', 0)
    monthly = tier_config.get('monthlyLimit', 0)
    if not USAGE_TABLE or not user_id or not any([daily, weekly, monthly]):
        return True, ''
    try:
        today = datetime.now(timezone.utc)
        dates = [(today - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(30)]
        resp  = ddb.batch_get_item(RequestItems={
            USAGE_TABLE: {'Keys': [{'userId': user_id, 'date': d} for d in dates]}
        })
        rows    = resp.get('Responses', {}).get(USAGE_TABLE, [])
        by_date = {r['date']: int(r.get('totalTokens', 0)) for r in rows}

        if daily:
            d = by_date.get(today.strftime('%Y-%m-%d'), 0)
            if d >= daily:
                return False, f'Daily limit reached ({d:,}/{daily:,} tokens)'
        if weekly:
            w = sum(by_date.get((today - timedelta(days=i)).strftime('%Y-%m-%d'), 0) for i in range(7))
            if w >= weekly:
                return False, f'Weekly limit reached ({w:,}/{weekly:,} tokens)'
        if monthly:
            m = sum(by_date.get((today - timedelta(days=i)).strftime('%Y-%m-%d'), 0) for i in range(30))
            if m >= monthly:
                return False, f'Monthly limit reached ({m:,}/{monthly:,} tokens)'
        return True, ''
    except Exception as e:
        print(f'Usage limit check failed: {e}')
        return True, ''  # fail open


# ── API handler ──────────────────────────────────────────────────────────────

def handler(event, context):
    ctx    = event.get('requestContext', {}).get('http', {})
    method = ctx.get('method', '')
    path   = ctx.get('path', '').rstrip('/')

    if method == 'GET'  and path.endswith('/features'):
        return get_features()
    if method == 'PUT'  and '/admin/features/' in path:
        return admin_update_feature(event, path.split('/')[-1])
    if method == 'POST' and path.endswith('/telemetry'):
        return record_visit(event)
    if method == 'GET'  and path.endswith('/admin/visits'):
        return admin_visits(event)
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
    if method == 'POST' and path.endswith('/extract-structure'):
        return start_job(event, 'extract-structure')
    if method == 'GET'  and '/extract-structure/' in path:
        return poll(path.split('/')[-1])
    if method == 'GET'    and path.endswith('/admin/users'):
        return admin_list_users(event)
    if method == 'POST'   and path.endswith('/admin/users'):
        return admin_create_user(event)
    if method == 'DELETE' and '/admin/users/' in path:
        return admin_delete_user(event, path.split('/')[-1])
    if method == 'PUT'    and '/admin/users/' in path and path.endswith('/tier'):
        return admin_set_user_tier(event, path.split('/')[-2])
    if method == 'PUT'    and '/admin/users/' in path and path.endswith('/admin-role'):
        return admin_set_user_admin_role(event, path.split('/')[-2])
    if method == 'GET'  and path.endswith('/admin/status'):
        return admin_status(event)
    if method == 'GET'  and path.endswith('/admin/usage'):
        return admin_usage(event)
    if method == 'GET'  and path.endswith('/admin/tiers'):
        return admin_get_tiers(event)
    if method == 'PUT'  and '/admin/tiers/' in path:
        return admin_update_tier(event, path.split('/')[-1])
    if method == 'GET'  and path.endswith('/admin/interest'):
        return admin_interest(event)
    return out(404, {'error': 'not found'})


def start_job(event, job_type):
    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return out(400, {'error': 'invalid JSON'})

    user_id     = _user_id(event)
    tier        = _get_user_tier(event)
    tier_config = _get_tier_config(tier)

    ok, reason = _check_usage_limit(user_id, tier_config)
    if not ok:
        return out(429, {'error': reason})

    # Determine model: user may request 'simple' or 'complex', but Explorer is capped at 'simple'
    requested = body.get('model', tier_config['model'])
    if requested not in ('simple', 'complex'):
        requested = tier_config['model']
    if requested == 'complex' and tier_config['model'] == 'simple':
        return out(403, {'error': 'upgrade_required',
                         'message': 'Upgrade to Trailblazer or Uncharted to use the Complex model.'})
    mode = requested

    job_id = str(uuid.uuid4())
    ttl    = int((datetime.now(timezone.utc) + timedelta(hours=24)).timestamp())
    now    = datetime.now(timezone.utc).isoformat()

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
                      Body=json.dumps(pages), ContentType='application/json')
        item['s3Key'] = s3_key
        item['pageCount'] = len(pages)
        if existing:
            item['existing'] = json.dumps(existing)

    elif job_type == 'extract-structure':
        text = str(body.get('text', '')).strip()
        if not text:
            return out(400, {'error': 'text is required'})
        existing_structure = body.get('existingStructure', [])
        # Store text in S3 (avoids DynamoDB 400 KB limit; same pattern as PDF)
        s3_key = f'structure-jobs/{job_id}.txt'
        s3.put_object(Bucket=PDF_BUCKET, Key=s3_key,
                      Body=text.encode('utf-8'), ContentType='text/plain; charset=utf-8')
        item['s3Key'] = s3_key
        if existing_structure:
            item['existing'] = json.dumps(existing_structure)

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

    resp = {'jobId': job_id, 'status': status, 'jobType': item.get('jobType', 'extract')}
    if status == 'done':
        resp['result'] = json.loads(item.get('result', '{}'))
    elif status == 'error':
        resp['error'] = item.get('error', 'Processing timed out or failed')
    return out(200, resp)


# ── Admin — users ─────────────────────────────────────────────────────────────

def admin_list_users(event):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})
    if not USER_POOL_ID:
        return out(500, {'error': 'USER_POOL_ID not configured'})

    # Build username→groups map via ListUsersInGroup (one call per group)
    group_membership = {}  # username → [group, ...]
    for group in ('admins', 'explorer', 'trailblazer', 'uncharted'):
        nt = None
        while True:
            kwargs = {'UserPoolId': USER_POOL_ID, 'GroupName': group, 'Limit': 60}
            if nt:
                kwargs['NextToken'] = nt
            try:
                resp = cognito.list_users_in_group(**kwargs)
            except cognito.exceptions.ResourceNotFoundException:
                break
            for u in resp.get('Users', []):
                username = u.get('Username', '')
                group_membership.setdefault(username, []).append(group)
            nt = resp.get('NextToken')
            if not nt:
                break

    users, pt = [], None
    while True:
        kwargs = {'UserPoolId': USER_POOL_ID, 'Limit': 60}
        if pt:
            kwargs['PaginationToken'] = pt
        resp = cognito.list_users(**kwargs)
        for u in resp.get('Users', []):
            attrs    = {a['Name']: a['Value'] for a in u.get('Attributes', [])}
            username = u.get('Username', '')
            users.append({
                'username': username,
                'sub':      attrs.get('sub', ''),
                'email':    attrs.get('email', username),
                'status':   u.get('UserStatus', ''),
                'enabled':  u.get('Enabled', True),
                'created':  u['UserCreateDate'].isoformat() if u.get('UserCreateDate') else '',
                'groups':   group_membership.get(username, []),
            })
        pt = resp.get('PaginationToken')
        if not pt:
            break

    users.sort(key=lambda u: u['email'])
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


def admin_set_user_tier(event, username):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})
    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return out(400, {'error': 'invalid JSON'})

    tier = body.get('tier') or ''
    if tier and tier not in TIER_DEFAULTS:
        return out(400, {'error': f'Unknown tier: {tier}'})

    # Remove from all tier groups first (ignore errors if not a member)
    for t in ('explorer', 'trailblazer', 'uncharted'):
        try:
            cognito.admin_remove_user_from_group(UserPoolId=USER_POOL_ID, Username=username, GroupName=t)
        except Exception:
            pass

    if tier:
        try:
            cognito.admin_add_user_to_group(UserPoolId=USER_POOL_ID, Username=username, GroupName=tier)
        except Exception as e:
            return out(500, {'error': str(e)})

    return out(200, {'ok': True})


def admin_set_user_admin_role(event, username):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})

    caller = event['requestContext']['authorizer']['jwt']['claims'].get('email', '')
    if caller and caller.lower() == username.lower():
        return out(400, {'error': 'Cannot modify your own admin status'})

    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return out(400, {'error': 'invalid JSON'})

    make_admin = bool(body.get('admin', False))
    try:
        if make_admin:
            cognito.admin_add_user_to_group(UserPoolId=USER_POOL_ID, Username=username, GroupName='admins')
        else:
            cognito.admin_remove_user_from_group(UserPoolId=USER_POOL_ID, Username=username, GroupName='admins')
    except Exception as e:
        return out(500, {'error': str(e)})

    return out(200, {'ok': True})


def admin_delete_user(event, username):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})
    if not USER_POOL_ID:
        return out(500, {'error': 'USER_POOL_ID not configured'})
    # Prevent self-deletion
    caller = event['requestContext']['authorizer']['jwt']['claims'].get('email', '')
    if caller and caller.lower() == username.lower():
        return out(400, {'error': 'Cannot delete your own account'})
    try:
        cognito.admin_delete_user(UserPoolId=USER_POOL_ID, Username=username)
        return out(200, {'ok': True})
    except cognito.exceptions.UserNotFoundException:
        return out(404, {'error': 'User not found'})
    except Exception as e:
        return out(500, {'error': str(e)})


# ── Admin — status ────────────────────────────────────────────────────────────

def admin_status(event):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})

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

    user_count, pt = 0, None
    try:
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
        },
    })


# ── Admin — usage ─────────────────────────────────────────────────────────────

def admin_usage(event):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})
    if not USAGE_TABLE:
        return out(200, {'rows': []})

    try:
        today = datetime.now(timezone.utc)
        rows  = ddb.Table(USAGE_TABLE).scan().get('Items', [])

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


# ── Telemetry (visit beacon) ──────────────────────────────────────────────────

def record_visit(event):
    if not VISITS_TABLE:
        return out(200, {'ok': True})
    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return out(200, {'ok': True})

    sid  = str(body.get('sid', ''))[:64]
    uid  = str(body.get('uid', 'anon'))[:128]
    auth = bool(body.get('auth', False))

    if not sid:
        return out(200, {'ok': True})

    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    ttl   = int((datetime.now(timezone.utc) + timedelta(days=90)).timestamp())

    try:
        ddb.Table(VISITS_TABLE).put_item(
            Item={'date': today, 'sid': sid, 'uid': uid, 'auth': auth,
                  'ts': datetime.now(timezone.utc).isoformat(), 'ttl': ttl},
            ConditionExpression='attribute_not_exists(sid)',
        )
    except ddb.meta.client.exceptions.ConditionalCheckFailedException:
        pass  # already recorded this session today
    except Exception as e:
        print(f'visit record failed: {e}')

    return out(200, {'ok': True})


def admin_visits(event):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})
    if not VISITS_TABLE:
        return out(200, {'daily': [], 'weekly': [], 'monthly': []})

    try:
        today  = datetime.now(timezone.utc).date()
        cutoff = (today - timedelta(days=90)).isoformat()

        resp  = ddb.Table(VISITS_TABLE).scan(
            FilterExpression='#d >= :cutoff',
            ExpressionAttributeNames={'#d': 'date'},
            ExpressionAttributeValues={':cutoff': cutoff},
        )
        rows = resp.get('Items', [])
        while resp.get('LastEvaluatedKey'):
            resp = ddb.Table(VISITS_TABLE).scan(
                FilterExpression='#d >= :cutoff',
                ExpressionAttributeNames={'#d': 'date'},
                ExpressionAttributeValues={':cutoff': cutoff},
                ExclusiveStartKey=resp['LastEvaluatedKey'],
            )
            rows.extend(resp.get('Items', []))

        def _agg(buckets):
            result = []
            for label in sorted(buckets):
                sessions = buckets[label]
                total    = len(sessions)
                auth     = sum(1 for s in sessions if s.get('auth'))
                unauth   = total - auth
                unique   = len({s['uid'] for s in sessions if s.get('auth')})
                result.append({'label': label, 'total': total, 'auth': auth,
                               'anon': unauth, 'unique': unique})
            return result

        daily, weekly, monthly = {}, {}, {}
        for row in rows:
            d = row.get('date', '')
            if not d:
                continue
            # daily bucket: the date itself
            daily.setdefault(d, []).append(row)
            # weekly bucket: ISO week YYYY-Www
            try:
                dt   = datetime.strptime(d, '%Y-%m-%d').date()
                week = f"{dt.isocalendar()[0]}-W{dt.isocalendar()[1]:02d}"
                weekly.setdefault(week, []).append(row)
                month = d[:7]  # YYYY-MM
                monthly.setdefault(month, []).append(row)
            except Exception:
                pass

        all_auth  = sum(1 for r in rows if r.get('auth'))
        all_anon  = len(rows) - all_auth
        all_unique = len({r['uid'] for r in rows if r.get('auth')})

        return out(200, {
            'daily':   list(reversed(_agg(daily)[-30:])),
            'weekly':  list(reversed(_agg(weekly)[-12:])),
            'monthly': list(reversed(_agg(monthly)[-12:])),
            'totals90d': {
                'total': len(rows), 'auth': all_auth,
                'anon': all_anon, 'unique': all_unique,
            },
        })
    except Exception as e:
        return out(500, {'error': str(e)})


# ── Admin — tiers ─────────────────────────────────────────────────────────────

def admin_get_tiers(event):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})

    tiers = []
    for tier_id in ('explorer', 'trailblazer', 'uncharted'):
        cfg = _get_tier_config(tier_id)
        tiers.append({
            'tierId':       tier_id,
            'label':        TIER_LABELS[tier_id],
            'model':        cfg['model'],
            'dailyLimit':   cfg['dailyLimit'],
            'weeklyLimit':  cfg['weeklyLimit'],
            'monthlyLimit': cfg['monthlyLimit'],
        })
    return out(200, {'tiers': tiers})


def admin_update_tier(event, tier_id):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})
    if tier_id not in TIER_DEFAULTS:
        return out(404, {'error': f'Unknown tier: {tier_id}'})
    if not TIERS_TABLE:
        return out(500, {'error': 'TIERS_TABLE not configured'})

    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return out(400, {'error': 'invalid JSON'})

    defaults = TIER_DEFAULTS[tier_id]
    model    = body.get('model',        defaults['model'])
    daily    = int(body.get('dailyLimit',   defaults['dailyLimit']))
    weekly   = int(body.get('weeklyLimit',  defaults['weeklyLimit']))
    monthly  = int(body.get('monthlyLimit', defaults['monthlyLimit']))

    if model not in ('simple', 'complex'):
        return out(400, {'error': 'model must be simple or complex'})

    ddb.Table(TIERS_TABLE).put_item(Item={
        'tierId':       tier_id,
        'model':        model,
        'dailyLimit':   daily,
        'weeklyLimit':  weekly,
        'monthlyLimit': monthly,
    })
    return out(200, {'ok': True})


# ── Feature flags ─────────────────────────────────────────────────────────────

def _load_flag(flag_id):
    defaults = FEATURE_DEFAULTS[flag_id]
    if not FEATURES_TABLE:
        return dict(defaults)
    try:
        item = ddb.Table(FEATURES_TABLE).get_item(Key={'flagId': flag_id}).get('Item')
        if not item:
            return dict(defaults)
        flag = dict(defaults)
        flag['enabled'] = bool(item.get('enabled', defaults['enabled']))
        for k in defaults:
            if k not in ('flagId', 'label', 'description', 'enabled'):
                flag[k] = item.get(k, defaults[k])
        return flag
    except Exception:
        return dict(defaults)

def get_features():
    return out(200, {fid: _load_flag(fid) for fid in FEATURE_DEFAULTS})

def admin_update_feature(event, flag_id):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})
    if flag_id not in FEATURE_DEFAULTS:
        return out(404, {'error': f'Unknown flag: {flag_id}'})
    if not FEATURES_TABLE:
        return out(500, {'error': 'FEATURES_TABLE not configured'})
    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return out(400, {'error': 'invalid JSON'})

    defaults = FEATURE_DEFAULTS[flag_id]
    item = {'flagId': flag_id, 'enabled': bool(body.get('enabled', defaults['enabled']))}
    for k, v in defaults.items():
        if k not in ('flagId', 'label', 'description', 'enabled'):
            raw = body.get(k, v)
            item[k] = str(raw) if raw is not None else str(v)

    ddb.Table(FEATURES_TABLE).put_item(Item=item)
    return out(200, {'ok': True})


# ── Admin — interest analytics ────────────────────────────────────────────────

def admin_interest(event):
    if not _is_admin(event):
        return out(403, {'error': 'forbidden'})
    if not INTEREST_BUCKET:
        return out(500, {'error': 'INTEREST_BUCKET not configured'})

    try:
        rows = []
        paginator = s3.get_paginator('list_objects_v2')
        for page in paginator.paginate(Bucket=INTEREST_BUCKET, Prefix='submissions/'):
            for obj in page.get('Contents', []):
                if not obj['Key'].endswith('.json'):
                    continue
                try:
                    body   = s3.get_object(Bucket=INTEREST_BUCKET, Key=obj['Key'])['Body'].read()
                    record = json.loads(body)
                    rows.append({
                        'timestamp': record.get('timestamp', ''),
                        'name':      record.get('name', ''),
                        'email':     record.get('email', ''),
                        'interested': bool(record.get('subscriptionInterest', False)),
                    })
                except Exception:
                    continue

        rows.sort(key=lambda r: r['timestamp'], reverse=True)

        total      = len(rows)
        interested = sum(1 for r in rows if r['interested'])

        daily = {}
        for r in rows:
            day = r['timestamp'][:10]
            if not day:
                continue
            if day not in daily:
                daily[day] = {'day': day, 'total': 0, 'interested': 0}
            daily[day]['total'] += 1
            if r['interested']:
                daily[day]['interested'] += 1

        return out(200, {
            'total':      total,
            'interested': interested,
            'daily':      sorted(daily.values(), key=lambda x: x['day'], reverse=True),
            'recent':     rows[:20],
        })

    except Exception as e:
        return out(500, {'error': str(e)})


# ── Interest form ─────────────────────────────────────────────────────────────

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

    record = {'timestamp': now.isoformat(), 'name': name,
              'email': email, 'subscriptionInterest': sub}

    if INTEREST_BUCKET:
        key = f"submissions/{now.strftime('%Y/%m/%d')}/{uuid.uuid4()}.json"
        s3.put_object(Bucket=INTEREST_BUCKET, Key=key,
                      Body=json.dumps(record), ContentType='application/json')

    return out(200, {'ok': True})


# ── World persistence ─────────────────────────────────────────────────────────

def _user_id(event):
    try:
        return event['requestContext']['authorizer']['jwt']['claims']['sub']
    except (KeyError, TypeError):
        return None

CONTENT_CHUNK_BYTES = 256 * 1024  # 256 KB per S3 chunk

def _content_s3_prefix(uid):
    return f'world-content/{uid}'

def get_world(event):
    uid = _user_id(event)
    if not uid:
        return out(401, {'error': 'unauthorized'})
    item = ddb.Table(WORLD_TABLE).get_item(Key={'userId': uid}).get('Item')
    if not item:
        return out(404, {'error': 'no world found'})

    # Reassemble content from S3 chunks
    content = {}
    chunk_keys = item.get('contentChunks') or []
    if chunk_keys and PDF_BUCKET:
        try:
            from concurrent.futures import ThreadPoolExecutor, as_completed
            def _fetch(key):
                return s3.get_object(Bucket=PDF_BUCKET, Key=key)['Body'].read()
            with ThreadPoolExecutor(max_workers=min(len(chunk_keys), 8)) as pool:
                futures = {pool.submit(_fetch, k): i for i, k in enumerate(chunk_keys)}
                parts   = [None] * len(chunk_keys)
                for fut in as_completed(futures):
                    parts[futures[fut]] = fut.result()
            content = json.loads(b''.join(parts).decode('utf-8'))
        except Exception as e:
            print(f'Content fetch failed: {e}')

    return out(200, {'data': json.loads(item['data']), 'content': content,
                     'updatedAt': item['updatedAt']})

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
    content = body.get('content') or {}

    now = datetime.now(timezone.utc).isoformat()

    # Write content to S3 in 256KB chunks
    chunk_keys = []
    if content and PDF_BUCKET:
        content_bytes = json.dumps(content, ensure_ascii=False).encode('utf-8')
        raw_chunks = [content_bytes[i:i+CONTENT_CHUNK_BYTES]
                      for i in range(0, max(len(content_bytes), 1), CONTENT_CHUNK_BYTES)]
        prefix = _content_s3_prefix(uid)
        for i, chunk in enumerate(raw_chunks):
            key = f'{prefix}-{i}.json'
            s3.put_object(Bucket=PDF_BUCKET, Key=key, Body=chunk,
                          ContentType='application/json')
            chunk_keys.append(key)
        # Delete any old chunks beyond the new count
        old_count = int(body.get('_prevChunkCount', len(raw_chunks) + 10))
        for i in range(len(raw_chunks), old_count + 1):
            try: s3.delete_object(Bucket=PDF_BUCKET, Key=f'{prefix}-{i}.json')
            except Exception: pass

    item = {'userId': uid, 'data': json.dumps(world_data), 'updatedAt': now}
    if chunk_keys:
        item['contentChunks'] = chunk_keys
    ddb.Table(WORLD_TABLE).put_item(Item=item)
    return out(200, {'updatedAt': now, 'contentChunks': len(chunk_keys)})


# ── Async processor ───────────────────────────────────────────────────────────

def process(event, context):
    job_id   = event.get('jobId')
    job_type = event.get('jobType', 'extract')
    table    = ddb.Table(TABLE)
    item     = table.get_item(Key={'jobId': job_id}).get('Item')
    if not item:
        return

    usage = {'input': 0, 'output': 0}

    try:
        existing = json.loads(item.get('existing', '[]'))
        model_id = resolve_model(item.get('modelMode', 'simple'))
        user_id  = item.get('userId')

        if job_type == 'extract':
            result = run_extract_agent(item.get('text', ''), existing, model_id, usage)
        elif job_type == 'extract-pdf':
            obj    = s3.get_object(Bucket=PDF_BUCKET, Key=item.get('s3Key', ''))
            pages  = json.loads(obj['Body'].read())
            result = run_extract_pdf_agent(pages, existing, model_id, usage)
        elif job_type == 'extract-structure':
            existing_structure = json.loads(item.get('existing', '[]'))
            obj  = s3.get_object(Bucket=PDF_BUCKET, Key=item.get('s3Key', ''))
            text = obj['Body'].read().decode('utf-8')
            result = run_structure_agent(text, existing_structure, model_id, usage)
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
    chunks = []
    for i in range(0, len(pages), PDF_CHUNK_PAGES):
        chunk_pages = pages[i:i + PDF_CHUNK_PAGES]
        text = '\n\n'.join(f'[Page {i+j+1}]\n{chunk_pages[j]}' for j in range(len(chunk_pages)))
        chunks.append({'index': len(chunks), 'start': i+1, 'end': i+len(chunk_pages), 'text': text})

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
        chunk        = chunks[chunk_index]
        sub_existing = existing + state['creates']
        result       = run_extract_agent(chunk['text'], sub_existing, model_id, usage)
        state['creates'].extend(result.get('creates', []))
        state['updates'].extend(result.get('updates', []))
        state['links'].extend(result.get('links', []))
        state['done'].add(chunk_index)
        return f"Pages {chunk['start']}–{chunk['end']}: {len(result.get('creates',[]))} new, {len(result.get('links',[]))} links."

    @tool
    def finalize() -> str:
        """Deduplicate all results after all chunks are processed. Call exactly once."""
        state['creates'] = _dedupe(state['creates'])
        return f"Finalized: {len(state['creates'])} unique entities."

    existing_ctx = _existing_ctx(existing)
    chunk_list   = "\n".join(f"  [{c['index']}] pages {c['start']}–{c['end']}" for c in chunks)

    agent = Agent(
        model=BedrockModel(model_id=model_id),
        tools=[process_chunk, finalize],
        system_prompt=(
            "You are an orchestrator for literary analysis of a full novel. "
            "Call process_chunk(chunk_index) for every chunk sequentially (0, 1, 2, …), "
            "then call finalize() exactly once."
        ),
    )
    r = agent(f"{existing_ctx}Novel split into {len(chunks)} chunk(s):\n{chunk_list}\n\nProcess all chunks in order, then finalize.")
    _add_usage(r, usage)

    return {'creates': _dedupe(state['creates']), 'updates': state['updates'], 'links': state['links']}


# ── Extract agent ─────────────────────────────────────────────────────────────

def run_extract_agent(text: str, existing: list, model_id: str, usage: dict = None) -> dict:
    words = text.split()
    state = {
        'queue':   [' '.join(words[i:i+CHUNK_WORDS]) for i in range(0, len(words), CHUNK_WORDS)],
        'creates': [], 'updates': [], 'links': [],
    }

    @tool
    def get_next_chunk() -> str:
        """Return the next unprocessed text chunk. Returns NO_MORE_CHUNKS when done."""
        return state['queue'].pop(0) if state['queue'] else 'NO_MORE_CHUNKS'

    @tool
    def create_entity(entity_type: str, name: str, description: str,
                      role: str = '', loc_type: str = '', date: str = '',
                      importance: str = '', gender: str = '', skin_tone: str = '',
                      hair_style: str = '', hair_color: str = '', eye_color: str = '') -> str:
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
        return f"Queued: {entity_type} '{name}'"

    @tool
    def update_entity(entity_id: str, field_updates: dict) -> str:
        """Update fields of an EXISTING entity.
        Args:
            entity_id: the [ID] from the existing entity list
            field_updates: dict of fields to update
        """
        state['updates'].append({'id': entity_id, 'changes': field_updates})
        return f"Queued update for {entity_id}"

    @tool
    def create_link(source_name: str, target_name: str, label: str) -> str:
        """Record a relationship between two entities.
        Args:
            source_name: exact name of the source entity
            target_name: exact name of the target entity
            label: short directional label (e.g. 'commands', 'member of', 'located in')
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
            "PHYSICAL TRAITS: For characters, extract appearance from the text when mentioned.\n\n"
            "RELATIONSHIPS: Call create_link for every relationship mentioned. "
            "Example: 'Captain Reyes commanded the Argo' → create_link('Captain Reyes','Argo','commands').\n\n"
            "Process all chunks with get_next_chunk before finishing."
        ),
    )

    total = len(state['queue'])
    r = agent(f"{_existing_ctx(existing)}Process the {total} text chunk(s). "
              "Call get_next_chunk, then create_entity or update_entity for each entity found.")
    _add_usage(r, usage)

    return {'creates': _dedupe(state['creates']), 'updates': state['updates'], 'links': state['links']}


# ── Analyze agent ─────────────────────────────────────────────────────────────

def run_analyze_agent(entities: list, model_id: str, usage: dict = None) -> dict:
    state = {'links': [], 'merges': []}

    lines = []
    for e in entities:
        existing_links = ', '.join(
            f"{l.get('targetId','')}({l.get('label','')})" for l in e.get('links', [])
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
            label: short directional label
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
            keep_id: ID to keep
            merge_id: ID to discard
            reason: explanation
        """
        state['merges'].append({'keepId': keep_id, 'mergeId': merge_id, 'reason': reason})
        return f"Suggested merge: keep {keep_id}, discard {merge_id}"

    agent = Agent(
        model=BedrockModel(model_id=model_id),
        tools=[suggest_link, suggest_merge],
        system_prompt=(
            "You are a literary analyst. Given a list of novel entities, suggest:\n\n"
            "MISSING LINKS: Relationships that should exist but aren't recorded.\n\n"
            "DUPLICATES: Entities likely to be the same thing with different names.\n\n"
            "Only suggest high-confidence items. Skip links that already exist."
        ),
    )

    r = agent("Here are all entities:\n\n" + "\n".join(lines) + "\n\nSuggest missing links and potential merges.")
    _add_usage(r, usage)

    return {'links': state['links'], 'merges': state['merges']}


# ── Structure extraction agent ────────────────────────────────────────────────

def run_structure_agent(text: str, existing_structure: list, model_id: str, usage: dict = None) -> dict:
    import threading
    from concurrent.futures import ThreadPoolExecutor, as_completed

    CHUNK_SIZE = 50_000  # chars ≈ 12,500 tokens

    chunks = [text[i:i + CHUNK_SIZE] for i in range(0, max(len(text), 1), CHUNK_SIZE)]
    total  = len(chunks)

    usage_lock = threading.Lock()

    EXTRACT_PROMPT = (
        "You are a narrative structure analyst. Extract the structure from this chunk of a novel.\n\n"
        "CALL ORDER:\n"
        "1. add_act — once per major division visible in this chunk (Part, Act, or one act if the chunk has no clear division)\n"
        "2. add_chapter — once per chapter, in reading order\n"
        "3. add_scene — once per distinct scene or beat within a chapter\n\n"
        "Each tool appends to the MOST RECENTLY created parent. Never skip levels.\n"
        "Give descriptive titles (2–6 words). Summarise what actually happens in the text."
    )

    def _make_extract_tools(chunk_state: dict):
        @tool
        def add_act(title: str, description: str = '') -> str:
            """Start a new act or major narrative part.
            Args:
                title: concise act title (2-6 words)
                description: 1-2 sentences summarising this act
            """
            chunk_state['acts'].append({'title': title, 'description': description, 'chapters': []})
            return f"Act '{title}' started."

        @tool
        def add_chapter(title: str, description: str = '') -> str:
            """Add a chapter to the most recently started act.
            Args:
                title: concise chapter title (2-6 words)
                description: 1-2 sentences summarising what happens
            """
            if not chunk_state['acts']:
                chunk_state['acts'].append({'title': 'Act I', 'description': '', 'chapters': []})
            chunk_state['acts'][-1]['chapters'].append({'title': title, 'description': description, 'scenes': []})
            return f"Chapter '{title}' added."

        @tool
        def add_scene(title: str, description: str = '') -> str:
            """Add a scene to the most recently started chapter.
            Args:
                title: concise scene title (2-6 words)
                description: 1-2 sentences summarising what happens
            """
            if not chunk_state['acts']:
                chunk_state['acts'].append({'title': 'Act I', 'description': '', 'chapters': []})
            if not chunk_state['acts'][-1]['chapters']:
                chunk_state['acts'][-1]['chapters'].append({'title': 'Chapter 1', 'description': '', 'scenes': []})
            chunk_state['acts'][-1]['chapters'][-1]['scenes'].append({'title': title, 'description': description})
            return f"Scene '{title}' added."

        return add_act, add_chapter, add_scene

    def extract_chunk(idx: int) -> tuple:
        chunk_state = {'acts': []}
        tools = _make_extract_tools(chunk_state)
        agent = Agent(
            model=BedrockModel(model_id=model_id),
            tools=list(tools),
            system_prompt=EXTRACT_PROMPT,
        )
        r = agent(f"CHUNK {idx + 1} OF {total}:\n\n{chunks[idx]}")
        with usage_lock:
            _add_usage(r, usage)
        return idx, chunk_state['acts']

    # ── Phase 1: parallel extraction ──────────────────────────────────────────
    partial = [None] * total
    with ThreadPoolExecutor(max_workers=min(total, 5)) as pool:
        futures = {pool.submit(extract_chunk, i): i for i in range(total)}
        for fut in as_completed(futures):
            idx, acts = fut.result()
            partial[idx] = acts

    if total == 1:
        return {'acts': partial[0] or []}

    # ── Phase 2: merge agent ───────────────────────────────────────────────────
    merged = {'acts': []}

    @tool
    def set_act(title: str, description: str = '') -> str:
        """Add an act to the unified merged structure.
        Args:
            title: canonical act title
            description: summary of this act
        """
        merged['acts'].append({'title': title, 'description': description, 'chapters': []})
        return f"Act '{title}' added to merged structure."

    @tool
    def set_chapter(title: str, description: str = '') -> str:
        """Add a chapter to the most recently added act in the merged structure.
        Args:
            title: canonical chapter title
            description: summary of this chapter
        """
        if not merged['acts']:
            merged['acts'].append({'title': 'Act I', 'description': '', 'chapters': []})
        merged['acts'][-1]['chapters'].append({'title': title, 'description': description, 'scenes': []})
        return f"Chapter '{title}' merged."

    @tool
    def set_scene(title: str, description: str = '') -> str:
        """Add a scene to the most recently added chapter in the merged structure.
        Args:
            title: canonical scene title
            description: summary of this scene
        """
        if not merged['acts']:
            merged['acts'].append({'title': 'Act I', 'description': '', 'chapters': []})
        if not merged['acts'][-1]['chapters']:
            merged['acts'][-1]['chapters'].append({'title': 'Chapter 1', 'description': '', 'scenes': []})
        merged['acts'][-1]['chapters'][-1]['scenes'].append({'title': title, 'description': description})
        return f"Scene '{title}' merged."

    # Format partial results for the merge prompt
    parts_text = []
    for i, acts in enumerate(partial):
        lines = [f"=== CHUNK {i + 1} ==="]
        for act in (acts or []):
            lines.append(f"Act: {act['title']}" + (f" — {act.get('description','')}" if act.get('description') else ''))
            for ch in act.get('chapters', []):
                lines.append(f"  Chapter: {ch['title']}" + (f" — {ch.get('description','')}" if ch.get('description') else ''))
                for sc in ch.get('scenes', []):
                    lines.append(f"    Scene: {sc['title']}")
        parts_text.append('\n'.join(lines))

    existing_ctx = ''
    if existing_structure:
        lines = ['PRE-EXISTING (already saved — omit from merged output):']
        for i, act in enumerate(existing_structure):
            lines.append(f"  Act {i+1}: {act.get('title','')}")
            for j, ch in enumerate(act.get('chapters', [])):
                lines.append(f"    Ch {j+1}: {ch.get('title','')}")
        existing_ctx = '\n'.join(lines) + '\n\n'

    merge_agent = Agent(
        model=BedrockModel(model_id=model_id),
        tools=[set_act, set_chapter, set_scene],
        system_prompt=(
            "You are merging parallel narrative structure extractions from consecutive chunks of the same novel.\n\n"
            "Rules:\n"
            "- Chunks are in reading order. The novel flows from chunk 1 → chunk N.\n"
            "- The same act may appear in multiple chunks — unify into one canonical act.\n"
            "- A chapter split across a chunk boundary appears in both chunks — include it once.\n"
            "- Every chapter and scene must appear exactly once in the merged output.\n"
            "- Preserve reading order. Use set_act → set_chapter → set_scene in sequence.\n"
            "- Omit anything listed as pre-existing."
        ),
    )

    r = merge_agent(
        f"{existing_ctx}"
        f"Merge these {total} parallel extractions into one coherent structure:\n\n"
        + '\n\n'.join(parts_text)
    )
    _add_usage(r, usage)

    return {'acts': merged['acts']}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _existing_ctx(existing):
    if not existing:
        return ''
    lines = []
    for e in existing:
        extra = e.get('role') or e.get('locType') or e.get('date') or ''
        desc  = (e.get('description') or '')[:80]
        lines.append(
            f"  [{e['id']}] {e['type'].upper()}: {e['name']}"
            + (f" ({extra})" if extra else '')
            + (f" — {desc}" if desc else '')
        )
    return "EXISTING ENTITIES (disambiguate against these):\n" + "\n".join(lines) + "\n\n"

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
