-- V1 基线：从 2026-07-08 生产 schema 用 pg_dump --schema-only 导出并清洗（去 psql 元命令/set_config/COMMENT ON EXTENSION）。
-- 现有库经 baseline-on-migrate 标记本版已应用(不重跑)；全新库由本脚本一次建全。此后表结构改动一律新增 V2+ 迁移，勿改本文件。

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.10 (Homebrew)
-- Dumped by pg_dump version 17.10 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--



SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_trace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_trace (
    id character varying(255) NOT NULL,
    app_version character varying(255),
    approval_triggered boolean NOT NULL,
    client_id character varying(255),
    client_ip character varying(255),
    completion_tokens bigint NOT NULL,
    connection_mode character varying(255),
    created_at timestamp(6) without time zone,
    department character varying(255),
    device_host character varying(255),
    duration_ms bigint NOT NULL,
    events text,
    expert_id character varying(255),
    expert_name character varying(255),
    final_answer text,
    knowledge_used character varying(255),
    model_name character varying(255),
    model_provider character varying(255),
    prompt_tokens bigint NOT NULL,
    reasoning_summary text,
    risk_level character varying(255),
    role character varying(255),
    sensitive_hit boolean NOT NULL,
    session_id character varying(255),
    skill_used character varying(255),
    sources text,
    spans text,
    status character varying(255),
    user_id character varying(255),
    user_nickname character varying(255),
    user_question text,
    web_search_used boolean NOT NULL,
    workspace character varying(255),
    feedback character varying(255),
    sandbox_used boolean DEFAULT false NOT NULL,
    failure_reason character varying(255)
);


--
-- Name: auth_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_role (
    name character varying(255) NOT NULL,
    builtin boolean NOT NULL,
    label character varying(255),
    permissions text
);


--
-- Name: auth_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_user (
    id character varying(255) NOT NULL,
    allow_all_experts boolean NOT NULL,
    assigned_expert_ids text,
    created_at timestamp(6) without time zone,
    department character varying(255),
    display_name character varying(255),
    enabled boolean NOT NULL,
    last_login_at timestamp(6) without time zone,
    must_change_password boolean NOT NULL,
    password_hash character varying(255),
    phone character varying(255),
    roles text,
    username character varying(255)
);


--
-- Name: client_node; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_node (
    client_id character varying(255) NOT NULL,
    app_version character varying(255),
    expert_id character varying(255),
    expert_name character varying(255),
    hostname character varying(255),
    im_command_count integer NOT NULL,
    last_seen timestamp(6) without time zone,
    pyodide_healthy boolean NOT NULL,
    sandbox_mode character varying(255)
);


--
-- Name: confirmation_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.confirmation_token (
    id character varying(255) NOT NULL,
    action_id character varying(255),
    capability character varying(255),
    connection_id character varying(255),
    consumed_at timestamp(6) without time zone,
    expires_at timestamp(6) without time zone,
    form_data_hash character varying(255),
    issued_at timestamp(6) without time zone,
    nonce character varying(255),
    signature character varying(128),
    skill_id character varying(255),
    status character varying(255),
    target_object_hash character varying(255),
    tenant_id character varying(255),
    user_id character varying(255)
);


--
-- Name: connector_action; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connector_action (
    id character varying(255) NOT NULL,
    action_key character varying(255),
    capability character varying(255),
    connection_id character varying(255),
    created_at timestamp(6) without time zone,
    fields_json text,
    name character varying(255),
    sop_hint text,
    steps_json text,
    system_id character varying(255),
    updated_at timestamp(6) without time zone,
    version character varying(255),
    ir_json text,
    kind character varying(255) DEFAULT 'replay'::character varying,
    api_method character varying(255),
    api_path character varying(255),
    api_body_template text,
    output_desc text
);


--
-- Name: desensitize_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.desensitize_audit (
    id bigint NOT NULL,
    created_at timestamp(6) without time zone,
    export_no character varying(255),
    exported boolean NOT NULL,
    hit_count integer NOT NULL,
    hit_rules character varying(255),
    mode character varying(255),
    operator character varying(255),
    role character varying(255),
    trace_id character varying(255)
);


--
-- Name: desensitize_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.desensitize_audit ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.desensitize_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: docling_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.docling_settings (
    id character varying(255) NOT NULL,
    convert_path character varying(255),
    do_ocr boolean NOT NULL,
    endpoint character varying(255),
    timeout_ms integer NOT NULL,
    updated_at timestamp(6) without time zone,
    container_name character varying(255),
    docker_host character varying(255),
    image character varying(255),
    host_port integer DEFAULT 5001
);


--
-- Name: enterprise_profile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enterprise_profile (
    id character varying(255) NOT NULL,
    address character varying(255),
    company_name character varying(255),
    rules text,
    tax_id character varying(255),
    updated_at timestamp(6) without time zone,
    info text
);


--
-- Name: expert; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expert (
    id character varying(255) NOT NULL,
    description text,
    knowledge_categories text,
    spec character varying(1000),
    title character varying(255),
    web_search_enabled boolean DEFAULT false NOT NULL,
    principles text,
    work_style text,
    ontology_domains text
);


--
-- Name: expert_skill; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expert_skill (
    expert_id character varying(255) NOT NULL,
    skill_id character varying(255) NOT NULL
);


--
-- Name: fde_blueprint; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fde_blueprint (
    id character varying(255) NOT NULL,
    content_json text,
    created_at timestamp(6) without time zone,
    markdown_draft text,
    name character varying(255),
    scenario_id character varying(255),
    updated_at timestamp(6) without time zone,
    version character varying(255)
);


--
-- Name: fde_delivery_package; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fde_delivery_package (
    id character varying(255) NOT NULL,
    blueprint_id character varying(255),
    content_json text,
    created_at timestamp(6) without time zone,
    published_skill_id character varying(255),
    scenario_id character varying(255),
    skill_markdown text,
    status character varying(255),
    submit_target character varying(255),
    updated_at timestamp(6) without time zone
);


--
-- Name: fde_project; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fde_project (
    id character varying(255) NOT NULL,
    created_at timestamp(6) without time zone,
    customer_name character varying(255),
    industry character varying(255),
    name character varying(255),
    owner character varying(255),
    pilot_department character varying(255),
    planned_launch_date character varying(255),
    stage character varying(255),
    updated_at timestamp(6) without time zone
);


--
-- Name: fde_scenario; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fde_scenario (
    id character varying(255) NOT NULL,
    business_role character varying(255),
    content_json text,
    created_at timestamp(6) without time zone,
    department character varying(255),
    description text,
    frequency character varying(255),
    name character varying(255),
    owner character varying(255),
    project_id character varying(255),
    reuse_potential character varying(255),
    risk_level character varying(255),
    status character varying(255),
    systems text,
    updated_at timestamp(6) without time zone
);


--
-- Name: fde_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fde_template (
    id character varying(255) NOT NULL,
    content_json text,
    created_at timestamp(6) without time zone,
    last_used_at timestamp(6) without time zone,
    name character varying(255),
    source_project_id character varying(255),
    type character varying(255),
    updated_at timestamp(6) without time zone,
    version character varying(255)
);


--
-- Name: fde_test_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fde_test_run (
    id character varying(255) NOT NULL,
    blueprint_id character varying(255),
    content_json text,
    created_at timestamp(6) without time zone,
    ended_at timestamp(6) without time zone,
    environment character varying(255),
    scenario_id character varying(255),
    started_at timestamp(6) without time zone,
    status character varying(255)
);


--
-- Name: gateway_daily_stat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gateway_daily_stat (
    id character varying(255) NOT NULL,
    completion_tokens bigint NOT NULL,
    failed bigint NOT NULL,
    prompt_tokens bigint NOT NULL,
    requests bigint NOT NULL
);


--
-- Name: knowledge_chunk; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_chunk (
    id bigint NOT NULL,
    document_id character varying(64) NOT NULL,
    category character varying(128),
    text text NOT NULL,
    embedding public.vector(384),
    created_at timestamp without time zone DEFAULT now(),
    scope character varying(16) DEFAULT 'ENTERPRISE'::character varying,
    owner_id character varying(64)
);


--
-- Name: knowledge_chunk_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knowledge_chunk_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_chunk_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knowledge_chunk_id_seq OWNED BY public.knowledge_chunk.id;


--
-- Name: knowledge_document; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_document (
    id character varying(255) NOT NULL,
    category character varying(255),
    chunk_overlap integer NOT NULL,
    chunk_size integer NOT NULL,
    chunks_count integer NOT NULL,
    filename character varying(255),
    size_bytes bigint NOT NULL,
    upload_time timestamp(6) without time zone,
    owner_id character varying(255),
    promotion_status character varying(255),
    proposed_category character varying(255),
    scope character varying(255)
);


--
-- Name: knowledge_image; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_image (
    id bigint NOT NULL,
    document_id character varying(64) NOT NULL,
    seq integer NOT NULL,
    data_uri text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: knowledge_image_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knowledge_image_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_image_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knowledge_image_id_seq OWNED BY public.knowledge_image.id;


--
-- Name: login_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_audit (
    id bigint NOT NULL,
    client_type character varying(255),
    created_at timestamp(6) without time zone,
    ip character varying(255),
    reason character varying(255),
    success boolean NOT NULL,
    user_agent character varying(512),
    user_id character varying(255),
    username character varying(255)
);


--
-- Name: login_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.login_audit ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.login_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: model_provider; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_provider (
    id character varying(255) NOT NULL,
    api_key character varying(1000),
    avg_latency_ms bigint NOT NULL,
    base_url character varying(255),
    enabled boolean NOT NULL,
    failed_requests bigint NOT NULL,
    last_checked timestamp(6) without time zone,
    message character varying(1000),
    model character varying(255),
    name character varying(255),
    provider character varying(255),
    route_key character varying(255),
    status character varying(255),
    total_requests bigint NOT NULL,
    weight integer NOT NULL,
    total_prompt_tokens bigint DEFAULT 0 NOT NULL,
    total_completion_tokens bigint DEFAULT 0 NOT NULL,
    input_price_per1k double precision,
    output_price_per1k double precision
);


--
-- Name: ontology_action; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ontology_action (
    id character varying(255) NOT NULL,
    action_key character varying(255),
    capability character varying(255),
    connector_action_id character varying(255),
    created_at timestamp(6) without time zone,
    description text,
    domain character varying(255),
    from_state character varying(255),
    label character varying(255),
    object_type character varying(255),
    policy_json text,
    to_state character varying(255),
    updated_at timestamp(6) without time zone
);


--
-- Name: ontology_business_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ontology_business_event (
    id character varying(255) NOT NULL,
    action_key character varying(255),
    actor_name character varying(255),
    actor_user_id character varying(255),
    created_at timestamp(6) without time zone,
    event_type character varying(255),
    from_state character varying(255),
    note text,
    object_ref_id character varying(255),
    object_type character varying(255),
    risk_level character varying(255),
    system_id character varying(255),
    tenant_id character varying(255),
    to_state character varying(255),
    trace_id character varying(255)
);


--
-- Name: ontology_object_ref; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ontology_object_ref (
    id character varying(255) NOT NULL,
    created_at timestamp(6) without time zone,
    current_state character varying(255),
    display_name character varying(255),
    external_id character varying(255),
    last_seen_at timestamp(6) without time zone,
    object_type character varying(255),
    owner_user_id character varying(255),
    system_id character varying(255),
    tenant_id character varying(255)
);


--
-- Name: ontology_type; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ontology_type (
    id character varying(255) NOT NULL,
    bound_system_id character varying(255),
    created_at timestamp(6) without time zone,
    description text,
    domain character varying(255),
    label character varying(255),
    properties_json text,
    relations_json text,
    state_machine_json text,
    type_key character varying(255),
    updated_at timestamp(6) without time zone,
    resolve_list_path character varying(255)
);


--
-- Name: password_reset_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_request (
    id character varying(255) NOT NULL,
    created_at timestamp(6) without time zone,
    handled_at timestamp(6) without time zone,
    phone character varying(255),
    status character varying(255),
    user_id character varying(255),
    username character varying(255)
);


--
-- Name: retrieval_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retrieval_audit (
    id bigint NOT NULL,
    client_id character varying(255),
    created_at timestamp(6) without time zone,
    hit boolean NOT NULL,
    latency_ms bigint NOT NULL,
    query_text character varying(1000),
    top_score double precision NOT NULL
);


--
-- Name: retrieval_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.retrieval_audit ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.retrieval_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sandbox_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sandbox_config (
    id bigint NOT NULL,
    cpu_quota double precision NOT NULL,
    docker_endpoint character varying(255),
    memory_quota_mb integer NOT NULL,
    mode character varying(255),
    network_isolation boolean NOT NULL,
    timeout_seconds integer NOT NULL,
    base_image character varying(255)
);


--
-- Name: search_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_config (
    id character varying(255) NOT NULL,
    api_key character varying(1000),
    browser_engine character varying(255),
    deep_read_count integer NOT NULL,
    max_results integer NOT NULL,
    provider character varying(255),
    updated_at timestamp(6) without time zone
);


--
-- Name: skill; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skill (
    id character varying(255) NOT NULL,
    allowed_roles text,
    code text,
    description character varying(1000),
    name character varying(255),
    sop_content text,
    source character varying(255),
    trigger_keywords text,
    type character varying(255),
    updated_at timestamp(6) without time zone,
    category character varying(255),
    status character varying(255),
    version character varying(255),
    target_system_id character varying(255),
    action_script text,
    nav_hash character varying(255),
    skill_kind character varying(255),
    bundle text
);


--
-- Name: sync_file; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_file (
    id bigint NOT NULL,
    audit_status character varying(255),
    created_at timestamp(6) without time zone,
    employee_name character varying(255),
    name character varying(255),
    path character varying(255),
    size_bytes bigint NOT NULL,
    summary character varying(1000),
    synced boolean NOT NULL
);


--
-- Name: sync_file_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sync_file ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.sync_file_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: system_connection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_connection (
    id character varying(255) NOT NULL,
    browser_profile_ref character varying(255),
    capabilities text,
    connector_version_range character varying(255),
    created_at timestamp(6) without time zone,
    device_id character varying(255),
    environment character varying(255),
    expires_at timestamp(6) without time zone,
    last_verified_at timestamp(6) without time zone,
    message character varying(1000),
    owner_user_id character varying(255),
    status character varying(255),
    system_id character varying(255),
    updated_at timestamp(6) without time zone
);


--
-- Name: system_integration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_integration (
    id character varying(255) NOT NULL,
    base_url character varying(255),
    last_checked timestamp(6) without time zone,
    message character varying(1000),
    name character varying(255),
    secret character varying(1000),
    status character varying(255),
    type character varying(255),
    username character varying(255)
);


--
-- Name: knowledge_chunk id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunk ALTER COLUMN id SET DEFAULT nextval('public.knowledge_chunk_id_seq'::regclass);


--
-- Name: knowledge_image id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_image ALTER COLUMN id SET DEFAULT nextval('public.knowledge_image_id_seq'::regclass);


--
-- Name: agent_trace agent_trace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_trace
    ADD CONSTRAINT agent_trace_pkey PRIMARY KEY (id);


--
-- Name: auth_role auth_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_role
    ADD CONSTRAINT auth_role_pkey PRIMARY KEY (name);


--
-- Name: auth_user auth_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);


--
-- Name: client_node client_node_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_node
    ADD CONSTRAINT client_node_pkey PRIMARY KEY (client_id);


--
-- Name: confirmation_token confirmation_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.confirmation_token
    ADD CONSTRAINT confirmation_token_pkey PRIMARY KEY (id);


--
-- Name: connector_action connector_action_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connector_action
    ADD CONSTRAINT connector_action_pkey PRIMARY KEY (id);


--
-- Name: desensitize_audit desensitize_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.desensitize_audit
    ADD CONSTRAINT desensitize_audit_pkey PRIMARY KEY (id);


--
-- Name: docling_settings docling_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.docling_settings
    ADD CONSTRAINT docling_settings_pkey PRIMARY KEY (id);


--
-- Name: enterprise_profile enterprise_profile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_profile
    ADD CONSTRAINT enterprise_profile_pkey PRIMARY KEY (id);


--
-- Name: expert expert_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expert
    ADD CONSTRAINT expert_pkey PRIMARY KEY (id);


--
-- Name: fde_blueprint fde_blueprint_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fde_blueprint
    ADD CONSTRAINT fde_blueprint_pkey PRIMARY KEY (id);


--
-- Name: fde_delivery_package fde_delivery_package_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fde_delivery_package
    ADD CONSTRAINT fde_delivery_package_pkey PRIMARY KEY (id);


--
-- Name: fde_project fde_project_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fde_project
    ADD CONSTRAINT fde_project_pkey PRIMARY KEY (id);


--
-- Name: fde_scenario fde_scenario_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fde_scenario
    ADD CONSTRAINT fde_scenario_pkey PRIMARY KEY (id);


--
-- Name: fde_template fde_template_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fde_template
    ADD CONSTRAINT fde_template_pkey PRIMARY KEY (id);


--
-- Name: fde_test_run fde_test_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fde_test_run
    ADD CONSTRAINT fde_test_run_pkey PRIMARY KEY (id);


--
-- Name: gateway_daily_stat gateway_daily_stat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateway_daily_stat
    ADD CONSTRAINT gateway_daily_stat_pkey PRIMARY KEY (id);


--
-- Name: knowledge_chunk knowledge_chunk_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_chunk
    ADD CONSTRAINT knowledge_chunk_pkey PRIMARY KEY (id);


--
-- Name: knowledge_document knowledge_document_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_document
    ADD CONSTRAINT knowledge_document_pkey PRIMARY KEY (id);


--
-- Name: knowledge_image knowledge_image_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_image
    ADD CONSTRAINT knowledge_image_pkey PRIMARY KEY (id);


--
-- Name: login_audit login_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_audit
    ADD CONSTRAINT login_audit_pkey PRIMARY KEY (id);


--
-- Name: model_provider model_provider_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_provider
    ADD CONSTRAINT model_provider_pkey PRIMARY KEY (id);


--
-- Name: ontology_action ontology_action_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ontology_action
    ADD CONSTRAINT ontology_action_pkey PRIMARY KEY (id);


--
-- Name: ontology_business_event ontology_business_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ontology_business_event
    ADD CONSTRAINT ontology_business_event_pkey PRIMARY KEY (id);


--
-- Name: ontology_object_ref ontology_object_ref_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ontology_object_ref
    ADD CONSTRAINT ontology_object_ref_pkey PRIMARY KEY (id);


--
-- Name: ontology_type ontology_type_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ontology_type
    ADD CONSTRAINT ontology_type_pkey PRIMARY KEY (id);


--
-- Name: password_reset_request password_reset_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_request
    ADD CONSTRAINT password_reset_request_pkey PRIMARY KEY (id);


--
-- Name: retrieval_audit retrieval_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retrieval_audit
    ADD CONSTRAINT retrieval_audit_pkey PRIMARY KEY (id);


--
-- Name: sandbox_config sandbox_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sandbox_config
    ADD CONSTRAINT sandbox_config_pkey PRIMARY KEY (id);


--
-- Name: search_config search_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_config
    ADD CONSTRAINT search_config_pkey PRIMARY KEY (id);


--
-- Name: skill skill_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill
    ADD CONSTRAINT skill_pkey PRIMARY KEY (id);


--
-- Name: sync_file sync_file_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_file
    ADD CONSTRAINT sync_file_pkey PRIMARY KEY (id);


--
-- Name: system_connection system_connection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_connection
    ADD CONSTRAINT system_connection_pkey PRIMARY KEY (id);


--
-- Name: system_integration system_integration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_integration
    ADD CONSTRAINT system_integration_pkey PRIMARY KEY (id);


--
-- Name: auth_user ukt1iph3dfc25ukwcl9xemtnojn; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT ukt1iph3dfc25ukwcl9xemtnojn UNIQUE (username);


--
-- Name: idx_knowledge_chunk_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_chunk_document ON public.knowledge_chunk USING btree (document_id);


--
-- Name: idx_knowledge_chunk_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_chunk_embedding ON public.knowledge_chunk USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_knowledge_chunk_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_chunk_owner ON public.knowledge_chunk USING btree (owner_id);


--
-- Name: idx_knowledge_chunk_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_chunk_scope ON public.knowledge_chunk USING btree (scope);


--
-- Name: idx_knowledge_image_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_knowledge_image_document ON public.knowledge_image USING btree (document_id);


--
-- Name: expert_skill fk5s2gnlfhef065sda3cq4r35l; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expert_skill
    ADD CONSTRAINT fk5s2gnlfhef065sda3cq4r35l FOREIGN KEY (skill_id) REFERENCES public.skill(id);


--
-- Name: expert_skill fkr6g53wmumpslmtu9mi7jw0u7v; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expert_skill
    ADD CONSTRAINT fkr6g53wmumpslmtu9mi7jw0u7v FOREIGN KEY (expert_id) REFERENCES public.expert(id);


--
-- PostgreSQL database dump complete
--


