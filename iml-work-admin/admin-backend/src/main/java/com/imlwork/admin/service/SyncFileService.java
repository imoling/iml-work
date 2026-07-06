package com.imlwork.admin.service;

import com.imlwork.admin.model.SyncFile;
import com.imlwork.admin.repository.SyncFileRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 员工客户端同步文件登记（上传归档 + 分页查询）。
 * 业务与事务在此，控制器只做 HTTP 塑形。
 */
@Service
public class SyncFileService {

    private static final int MAX_PAGE_SIZE = 1000;

    private final SyncFileRepository repository;

    public SyncFileService(SyncFileRepository repository) {
        this.repository = repository;
    }

    /** 同步文件随每次上传增长：按创建时间倒序取一页 + 上限兜底，不做全量返回。 */
    @Transactional(readOnly = true)
    public List<SyncFile> listRecent(int page, int size) {
        int capped = Math.max(1, Math.min(size, MAX_PAGE_SIZE));
        return repository
                .findAll(PageRequest.of(Math.max(0, page), capped, Sort.by(Sort.Direction.DESC, "createdAt")))
                .getContent();
    }

    /** 登记一条已同步归档的文件记录。 */
    @Transactional
    public SyncFile archive(String filename, String path, String summary, long sizeBytes, String employee) {
        SyncFile newFile = new SyncFile(filename, path, summary, true, sizeBytes, employee);
        return repository.save(newFile);
    }
}
